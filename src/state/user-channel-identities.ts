import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { Check } from "typebox/value";
import { z } from "zod";
import {
  GATEWAY_OWNER_PROFILE_ID,
  UserChannelIdentitySchema,
} from "../../packages/gateway-protocol/src/schema/users.js";
import type { GatewayConfig } from "../config/types.gateway.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import { updateConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  publishUserProfileAliasChange,
  publishUserChannelIdentityAuthorityChange,
  publishUserProfileAuthorityChange,
} from "./user-profile-events.js";
import { selectStoredGitHubIdentities } from "./user-profile-github-identity.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  requireResolvedUserProfileMetadataById,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileOwnerError } from "./user-profiles-schema.js";
import { classifyTailscaleLogin } from "./user-profiles-tailscale-login.js";
import type {
  UserChannelAuthorization,
  UserChannelAuthorizationPolicy,
  UserChannelAuthorizationReference,
  UserChannelIdentity,
  UserChannelIdentityLink,
  UserChannelIdentityAuthorityFacts,
  UserChannelIdentitySelector,
} from "./user-profiles.types.js";

// The dot keeps administrator-attested channel links outside Tailscale login namespaces.
const CHANNEL_IDENTITY_PROVIDER = "channel.identity";
const POLICY_KEY = "operator.channelPolicy";
const referenceSchema = z.strictObject({ version: z.literal(1), id: z.uuid() });
const configuredReferenceSchema = referenceSchema.extend({ version: z.literal(2) });
const configuredPolicySchema = z.strictObject({
  fingerprint: z.string().length(43),
  id: z.uuid(),
});
const commandReferenceSchema = z.union([referenceSchema, configuredReferenceSchema]);
export type CommandOwnerReference = Readonly<z.infer<typeof commandReferenceSchema>>;

export function parseCommandOwnerReference(value: unknown) {
  return commandReferenceSchema.safeParse(value).data;
}

export function configuredCommandOwnerPolicyFingerprint(owners?: readonly (string | number)[]) {
  const entries = normalizeSortedUniqueStringEntries(owners);
  return entries.length ? sha256Base64Url(JSON.stringify(entries)) : undefined;
}

function splitPolicy(value: unknown) {
  const { configuredOwnerPolicy, ...policy } = isRecord(value) ? value : {};
  return { policy, configured: configuredPolicySchema.safeParse(configuredOwnerPolicy).data };
}

export function readConfiguredCommandOwnerPolicy(value: unknown, fingerprint: string) {
  const { configured } = splitPolicy(value);
  return configured?.fingerprint === fingerprint
    ? { version: 2 as const, id: configured.id }
    : undefined;
}
const grantSchema = z
  .strictObject({ pluginId: z.string().min(1).max(128), grantId: z.uuid() })
  .nullable();
export function parseUserChannelAuthorizationReference(value: unknown) {
  return referenceSchema.safeParse(value).data;
}

export function resolveUserChannelAuthorizationPolicy(
  gateway: Pick<GatewayConfig, "roles" | "auth"> | undefined,
): UserChannelAuthorizationPolicy {
  return { roles: gateway?.roles ?? null, identityScopes: gateway?.auth?.identityScopes ?? null };
}
function matchesPolicy(db: DatabaseSync, policy: UserChannelAuthorizationPolicy): boolean {
  const row = readConfigMachineStateRowInDatabase(db, POLICY_KEY);
  return (
    row !== undefined && isDeepStrictEqual(splitPolicy(JSON.parse(row.value_json)).policy, policy)
  );
}

/** Activation and rollback retire old references before their exact authorization policy is published. */
export function publishUserChannelPolicyInDatabase(
  db: DatabaseSync,
  policy: UserChannelAuthorizationPolicy,
  configuredOwnersHash?: string,
) {
  let profiles: string[] = [];
  const channels: string[] = [];
  updateConfigMachineStateInDatabase(
    db,
    POLICY_KEY,
    (current: unknown) => {
      const previous = splitPolicy(current);
      if (
        !isDeepStrictEqual(previous.policy, policy) &&
        getAdmittedSqliteSchemaFacts(db)?.tables.has("user_profile_identities")
      ) {
        profiles = executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .selectFrom("user_profile_identities")
            .select("profile_id")
            .distinct()
            .where("provider", "=", CHANNEL_IDENTITY_PROVIDER),
        ).rows.map((row) => row.profile_id);
        publishUserProfileAuthorityChange(db, ...profiles);
      }
      const configured = configuredOwnersHash
        ? {
            fingerprint: configuredOwnersHash,
            id:
              previous.configured?.fingerprint === configuredOwnersHash
                ? previous.configured.id
                : generateSecureUuid(),
          }
        : undefined;
      if (!isDeepStrictEqual(previous.configured, configured)) {
        channels.push(POLICY_KEY);
        publishUserChannelIdentityAuthorityChange(db, POLICY_KEY);
      }
      return { ...policy, ...(configured ? { configuredOwnerPolicy: configured } : {}) };
    },
    Date.now(),
  );
  return { profiles, channels };
}

/** The reference names this uninterrupted channel link; it carries no permission by itself. */
export function authorizeUserChannelIdentityInDatabase(
  db: DatabaseSync,
  input: {
    identity: UserChannelIdentity;
    profileId: string;
    policy: UserChannelAuthorizationPolicy;
    grant: GatewayAccessGrantRef | null;
  },
): UserChannelAuthorizationReference | undefined {
  if (
    (getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0) < 19 ||
    !matchesPolicy(db, input.policy)
  ) {
    return undefined;
  }
  const subject = userChannelIdentitySubject(input.identity);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select(["authorization_id", "authorization_basis_json"])
      .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
      .where("subject", "=", subject)
      .where("profile_id", "=", input.profileId),
  );
  if (!row) {
    return undefined;
  }
  const basis = JSON.stringify(grantSchema.parse(input.grant));
  const original = referenceSchema.safeParse({ version: 1, id: row.authorization_id }).data;
  if (row.authorization_basis_json === basis && original) {
    return original;
  }
  const id = generateSecureUuid();
  executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .updateTable("user_profile_identities")
      .set({ authorization_id: id, authorization_basis_json: basis })
      .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
      .where("subject", "=", subject),
  );
  return { version: 1, id };
}

function readAuthorization(db: DatabaseSync, id: string, policy: UserChannelAuthorizationPolicy) {
  if ((getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0) < 19 || !matchesPolicy(db, policy)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select(["subject", "authorization_basis_json"])
      .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
      .where("authorization_id", "=", id),
  );
  if (!row?.authorization_basis_json || row.authorization_basis_json.length > 1024) {
    return undefined;
  }
  try {
    const grant = grantSchema.safeParse(JSON.parse(row.authorization_basis_json));
    return grant.success
      ? { subject: row.subject, reference: { version: 1 as const, id }, grant: grant.data }
      : undefined;
  } catch {
    return undefined;
  }
}

export class UserChannelIdentityConflictError extends Error {
  constructor() {
    super("channel identity is linked to another profile; unlink it from that profile first");
    this.name = "UserChannelIdentityConflictError";
  }
}

export function userChannelIdentitySubject(identity: UserChannelIdentity): string {
  if (!Check(UserChannelIdentitySchema, identity)) {
    throw new TypeError("invalid channel identity");
  }
  return JSON.stringify([identity.channelId, identity.accountId, identity.senderId]);
}

function readIdentity(subject: string): UserChannelIdentity | undefined {
  const tuple = safeParseJson(subject);
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    return undefined;
  }
  const identity = { channelId: tuple[0], accountId: tuple[1], senderId: tuple[2] };
  return Check(UserChannelIdentitySchema, identity) ? identity : undefined;
}

function selectLink(db: DatabaseSync, subject: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select("profile_id")
      .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
      .where("subject", "=", subject),
  );
}

function requirePerson(db: DatabaseSync, profileId: string) {
  const profile = requireResolvedUserProfileMetadataById(db, profileId);
  if (profileId === GATEWAY_OWNER_PROFILE_ID || profile.id === GATEWAY_OWNER_PROFILE_ID) {
    throw new UserProfileOwnerError("merge");
  }
  return profile;
}

function publishIdentityChange(db: DatabaseSync, profileId: string, subject: string) {
  publishUserChannelIdentityAuthorityChange(db, subject);
  publishUserProfilesChange(db, profileId);
  deferSqlitePostCommitPublication(db, publishUserProfileAliasChange);
}

/** An administrator attests the remote account belongs to this existing person. */
export function linkUserChannelIdentity(
  profileId: string,
  identity: UserChannelIdentity,
  options: OpenClawStateDatabaseOptions & { beforeChange?: (db: DatabaseSync) => void } = {},
): UserChannelIdentityLink {
  const subject = userChannelIdentitySubject(identity);
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requirePerson(db, profileId);
      const existing = selectLink(db, subject);
      if (existing) {
        if (requirePerson(db, existing.profile_id).id !== profile.id) {
          throw new UserChannelIdentityConflictError();
        }
        return { profileId: profile.id, identity };
      }
      options.beforeChange?.(db);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db).insertInto("user_profile_identities").values({
          provider: CHANNEL_IDENTITY_PROVIDER,
          subject,
          profile_id: profile.id,
          canonical_login: null,
          created_at: Date.now(),
        }),
      );
      publishIdentityChange(db, profile.id, subject);
      return { profileId: profile.id, identity };
    },
    options,
    { operationLabel: "user-profiles.link-channel-identity" },
  );
}

/** The expected person prevents a stale unlink from deleting another person's binding. */
export function unlinkUserChannelIdentity(
  profileId: string,
  identity: UserChannelIdentity,
  options: OpenClawStateDatabaseOptions & { beforeChange?: (db: DatabaseSync) => void } = {},
): boolean {
  const subject = userChannelIdentitySubject(identity);
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requirePerson(db, profileId);
      const existing = selectLink(db, subject);
      if (!existing) {
        return false;
      }
      if (requirePerson(db, existing.profile_id).id !== profile.id) {
        throw new UserChannelIdentityConflictError();
      }
      options.beforeChange?.(db);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .deleteFrom("user_profile_identities")
          .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
          .where("subject", "=", subject),
      );
      publishIdentityChange(db, profile.id, subject);
      return true;
    },
    options,
    { operationLabel: "user-profiles.unlink-channel-identity" },
  );
}

function hasIdentityTables(db: DatabaseSync): boolean {
  return tableExists(db, "user_profiles") && tableExists(db, "user_profile_identities");
}

export function listUserChannelIdentitiesInDatabase(
  db: DatabaseSync,
  profileId: string,
): UserChannelIdentityLink[] {
  return runSqliteDeferredTransactionSync(db, () => {
    if (!hasIdentityTables(db)) {
      return [];
    }
    const profile = requirePerson(db, profileId);
    return executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profile_identities")
        .select("subject")
        .where("provider", "=", CHANNEL_IDENTITY_PROVIDER)
        .where("profile_id", "=", profile.id)
        .orderBy("subject", "asc"),
    ).rows.flatMap(({ subject }) => {
      const identity = readIdentity(subject);
      return identity ? [{ profileId: profile.id, identity }] : [];
    });
  });
}

/** Reads the current person and login grant subjects; channel links never become login aliases. */
export function resolveUserChannelIdentityInDatabase(
  db: DatabaseSync,
  identity: UserChannelIdentitySelector,
): UserChannelIdentityAuthorityFacts | undefined {
  return runSqliteDeferredTransactionSync(db, () => {
    if (!hasIdentityTables(db)) {
      return undefined;
    }
    let authorization: UserChannelAuthorization | undefined;
    let subject: string;
    if ("authorizationId" in identity) {
      authorization = readAuthorization(db, identity.authorizationId, identity.policy);
      if (!authorization) {
        return undefined;
      }
      subject = authorization.subject;
    } else {
      subject = userChannelIdentitySubject(identity);
    }
    const link = selectLink(db, subject);
    const profile = link ? selectResolvedUserProfileMetadataById(db, link.profile_id) : undefined;
    if (!profile || profile.id === GATEWAY_OWNER_PROFILE_ID) {
      return undefined;
    }
    const kysely = userProfilesDb(db);
    const emails = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("user_profile_emails")
        .select("email")
        .where("profile_id", "=", profile.id)
        .orderBy("email", "asc"),
    ).rows.map(({ email }) => email);
    const loginEmails = emails.filter((email) => {
      const login = classifyTailscaleLogin(email);
      // Legacy email-shaped GitHub aliases must not revive a renamed login's grant.
      return login.kind !== "provider" || login.provider !== "github";
    });
    const providerLogins = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("user_profile_identities")
        .select(["provider", "subject"])
        .where("profile_id", "=", profile.id)
        .where("canonical_login", "is", null),
    )
      // Retired attribution rows are not authenticated provider-login aliases.
      .rows.filter(
        (row) =>
          row.provider !== "github" &&
          row.provider !== "github-attribution" &&
          !row.provider.includes("."),
      )
      .map((row) => `${row.subject}@${row.provider}`);
    const githubLogins =
      selectStoredGitHubIdentities(db, [profile.id])
        .get(profile.id)
        ?.accounts.map((account) => `${account.login.toLowerCase()}@github`) ?? [];
    return {
      ...(authorization ? { authorization } : {}),
      profileId: profile.id,
      role: profile.role ?? null,
      emails,
      loginIdentities: [
        ...new Set([...loginEmails, ...providerLogins, ...githubLogins]),
      ].toSorted(),
    };
  });
}

export function resolveUserChannelIdentity(
  identity: UserChannelIdentity,
  options: OpenClawStateDatabaseOptions = {},
): UserChannelIdentityAuthorityFacts | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => resolveUserChannelIdentityInDatabase(db, identity),
    options,
  );
}

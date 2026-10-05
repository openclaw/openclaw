import { createHash } from "node:crypto";
import { ModelAccountConnectAuthorityError } from "../gateway/model-account-connect-errors.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import {
  connectUserModelAccount,
  clearUserProfileAuthLink,
  setUserProfileAuthLink,
  listUserModelAccounts,
  readUserModelAccountSummary,
  readSelectedUserModelAccount,
} from "./user-model-accounts.js";
import { applyFactoryGitHubIdentity } from "./user-profile-factory-github-identity.js";
import {
  selectProfileAccessEntries,
  selectStoredGitHubIdentities,
} from "./user-profile-github-identity.js";
import { readUserProfileSnapshotSync } from "./user-profile-identity.read.js";
import { runUserProfileWriteTransaction } from "./user-profile-mutation.js";
import {
  createUserProfileWriteOperation,
  linkEmail,
  mergeProfiles,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import {
  inspectProfileAvatarInDatabase,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import {
  ensureFactoryGitHubProfile,
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "./user-profiles.js";
import type { ProfileDisplayRow, UserProfileAvatarMime } from "./user-profiles.types.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerOperationContext,
} from "./worker-operation-registry.js";

function accountWrite<Input extends { profileId: string }, Output>(
  write: (
    input: Input,
    options: OpenClawStateDatabaseOptions,
    admit: (stage: "transaction" | "commit") => void,
  ) => Output,
) {
  return (
    input: Input & { authorityProfileIds?: readonly string[] },
    { open, stateOptions }: WorkerOperationContext,
  ) => {
    const database = open();
    const facts = { kind: "model-account-links", profileId: input.profileId };
    return write(input, { ...stateOptions(), database }, (stage) => {
      const roles = (input.authorityProfileIds ?? []).map((profileId) => {
        const profile = selectResolvedUserProfileById(database.db, profileId);
        if (!profile || profile.id !== profileId || profile.merged_into) {
          throw new ModelAccountConnectAuthorityError();
        }
        return { profileId, role: profile.role ?? null };
      });
      requestSqliteWorkerOperationAdmission({ stage, facts: { ...facts, roles } });
      if (stage === "commit") {
        deferSqliteWorkerCommitReceipt(database.db, facts);
      }
    });
  };
}

const userProfileWriteOperations = {
  "userProfiles.setRole": createUserProfileWriteOperation(
    "userProfiles.setRole",
    (input: { profileId: string; role: string | null }, owned) =>
      setUserProfileRole(input.profileId, input.role, owned),
  ),
  "userProfiles.linkEmail": createUserProfileWriteOperation(
    "userProfiles.linkEmail",
    (input: { email: string; targetProfileId: string }, owned, display) => ({
      profile: linkEmail(input.email, input.targetProfileId, owned),
      display: display(),
    }),
    (input) => input.targetProfileId,
  ),
  "userProfiles.merge": createUserProfileWriteOperation(
    "userProfiles.merge",
    (input: { sourceProfileId: string; targetProfileId: string }, owned, display) => ({
      ...mergeProfiles(input.sourceProfileId, input.targetProfileId, owned),
      display: display(),
    }),
    (input) => input.targetProfileId,
  ),
  "userProfiles.ensureEmail": createUserProfileWriteOperation(
    "userProfiles.ensureEmail",
    (input: { email: string; expectedGitHubAccountId?: number }, owned) =>
      ensureProfileForEmail(input.email, {
        ...owned,
        expectedGitHubAccountId: input.expectedGitHubAccountId,
      }),
  ),
  "userProfiles.ensureFactoryGitHub": createUserProfileWriteOperation(
    "userProfiles.ensureFactoryGitHub",
    (
      input: {
        principal: string;
        name: string;
        verifiedMetadata?: { login: string; email?: string };
      },
      owned,
    ) => {
      const email = normalizeVerifiedEmail(input.verifiedMetadata?.email);
      if (input.verifiedMetadata?.email !== undefined && !email) {
        throw new Error("Factory verified email is invalid");
      }
      const profile = ensureFactoryGitHubProfile(input.principal, input.name, owned);
      // A conflicting new alias must still revoke the previous issuer's credit evidence.
      runUserProfileWriteTransaction(
        ({ db }) =>
          applyFactoryGitHubIdentity(db, {
            profileId: profile.id,
            principal: input.principal,
            metadata: input.verifiedMetadata,
            mutation: owned.mutation,
          }),
        owned,
        { operationLabel: "user-profiles.factory-github-identity" },
      );
      return email
        ? linkEmail(email, profile.id, { ...owned, preserveExistingBinding: true })
        : profile;
    },
  ),
  "userProfiles.ensureTailscale": createUserProfileWriteOperation(
    "userProfiles.ensureTailscale",
    (input: Parameters<typeof ensureProfileForTailscaleIdentity>[0], owned) =>
      ensureProfileForTailscaleIdentity(input, owned),
  ),
  "userProfiles.syncGitHub": createUserProfileWriteOperation(
    "userProfiles.syncGitHub",
    (input: Parameters<typeof syncGitHubIdentity>[0], owned) => syncGitHubIdentity(input, owned),
  ),
  "userProfiles.ensureOwner": createUserProfileWriteOperation(
    "userProfiles.ensureOwner",
    (input: { displayName: string | null }, owned) =>
      ensureGatewayOwnerProfile(input.displayName, owned),
  ),
  "userProfiles.setDisplayName": createUserProfileWriteOperation(
    "userProfiles.setDisplayName",
    (input: { profileId: string; name: string | null }, owned, display) => ({
      profile: setDisplayName(input.profileId, input.name, owned),
      display: display(),
    }),
    (input) => input.profileId,
  ),
  "userProfiles.setAvatar": createUserProfileWriteOperation(
    "userProfiles.setAvatar",
    (input: { profileId: string; bytes: Uint8Array; mime: string }, owned, display) => {
      const result = setAvatar(input.profileId, input.bytes, input.mime, owned);
      return result.ok
        ? { ok: true as const, value: { profile: result.value, display: display() } }
        : result;
    },
    (input) => input.profileId,
  ),
} satisfies WorkerOperationHandlers;

export type UserProfileWriteOperations = WorkerOperations<typeof userProfileWriteOperations>;

export const userProfileOperations = {
  ...userProfileWriteOperations,
  "userProfiles.modelAccount.connect": accountWrite(
    (
      input: Omit<
        Parameters<typeof connectUserModelAccount>[0],
        "ownerProfileId" | "assertCurrent"
      > & { profileId: string },
      options,
      assertCurrent,
    ) =>
      connectUserModelAccount(
        { ...input, ownerProfileId: input.profileId, assertCurrent },
        options,
      ),
  ),
  "userProfiles.modelAccount.link": accountWrite(
    (
      input: Omit<Parameters<typeof setUserProfileAuthLink>[0], "assertCurrent">,
      options,
      assertCurrent,
    ) => setUserProfileAuthLink({ ...input, assertCurrent }, options),
  ),
  "userProfiles.modelAccount.unlink": accountWrite(
    (
      input: Omit<Parameters<typeof clearUserProfileAuthLink>[0], "assertCurrent">,
      options,
      assertCurrent,
    ) => clearUserProfileAuthLink({ ...input, assertCurrent }, options),
  ),
  "userProfiles.modelAccount.list": (
    input: Parameters<typeof listUserModelAccounts>[0],
    { stateOptions },
  ) => listUserModelAccounts(input, stateOptions()),
  "userProfiles.modelAccount.summary": (
    input: Parameters<typeof readUserModelAccountSummary>[0],
    { stateOptions },
  ) => readUserModelAccountSummary(input, stateOptions()),
  "userProfiles.modelAccount.selected": (
    input: { profileId: string; provider: string },
    { stateOptions },
  ) => readSelectedUserModelAccount(input.profileId, input.provider, stateOptions()),
  "userProfiles.list": (
    input: { githubAccountIds: readonly number[] } | undefined,
    { open, stateOptions },
  ) => {
    const options = { ...stateOptions(), database: open() };
    return readUserProfileSnapshotSync(options, input?.githubAccountIds);
  },
  "userProfiles.directory": ({ limit }: { limit: number }, { open, stateOptions }) => {
    const database = open();
    ensureUserProfilesSchema(stateOptions(), database);
    return runSqliteDeferredTransactionSync(
      database.db,
      () => {
        const profiles = executeSqliteQuerySync(
          database.db,
          userProfilesDb(database.db)
            .selectFrom("user_profiles")
            .select("id")
            .where("merged_into", "is", null)
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .limit(limit + 1),
        ).rows;
        const selected = profiles.slice(0, limit);
        const identities = selectStoredGitHubIdentities(
          database.db,
          selected.map(({ id }) => id),
        );
        return {
          profiles: selected.map(({ id }) => ({
            id,
            logins: identities.get(id)?.accounts.map((account) => account.login) ?? [],
          })),
          truncated: profiles.length > limit,
        };
      },
      { databaseLabel: database.path, operationLabel: "user-profiles.directory" },
    );
  },
  "userProfiles.channelIdentity.change": (
    input: Parameters<typeof executeUserChannelIdentityChange>[0],
    { open, stateOptions },
  ) => executeUserChannelIdentityChange(input, { ...stateOptions(), database: open() }),
  "userProfiles.avatar.inspect": ({ profileId }: { profileId: string }, { open }) =>
    inspectProfileAvatarInDatabase(open().db, profileId),
  "userProfiles.avatar.adopt": (
    input: { profileId: string; bytes: Uint8Array; mime: UserProfileAvatarMime; now: number },
    { open, stateOptions },
  ): { profile: ReturnType<typeof toUserProfile> | undefined; committed?: ProfileDisplayRow } => {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const profile = selectResolvedUserProfileById(db, input.profileId);
        if (!profile) {
          return { profile: undefined };
        }
        if (profile.avatar !== null) {
          return { profile: toUserProfile(profile) };
        }
        const before = selectProfileAccessEntries(db, [profile.id])[0]![1];
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "profile-avatar", before },
        });
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .updateTable("user_profiles")
            .set({
              avatar: input.bytes,
              avatar_mime: input.mime,
              avatar_sha256: sha256,
              updated_at: input.now,
            })
            .where("id", "=", profile.id),
        );
        const committed = selectProfileAccessEntries(db, [profile.id])[0]![1];
        return {
          profile: toUserProfile({ ...profile, avatar_mime: input.mime, updated_at: input.now }),
          committed,
        };
      },
      { ...stateOptions(), database: open() },
      { operationLabel: "user-profiles.adopt-avatar" },
    );
  },
} satisfies WorkerOperationHandlers;

export type UserProfileWorkerOperations = WorkerOperations<typeof userProfileOperations>;

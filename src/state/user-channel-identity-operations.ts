import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import {
  UserChannelIdentityConflictError,
  userChannelIdentitySubject,
  resolveUserChannelAuthorizationPolicy,
  configuredCommandOwnerPolicyFingerprint,
  readConfiguredCommandOwnerPolicy,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import {
  captureUserProfileAuthorityRead,
  emitUserProfilesChanged,
  fenceUserProfileMutationAuthority,
  publishUserProfileAliasChange,
} from "./user-profile-events.js";
import { readUserProfileAuthorityFingerprint } from "./user-profile-identity.read.js";
import { UserProfileNotFoundError, UserProfileOwnerError } from "./user-profiles-schema.js";
import type {
  UserChannelIdentity,
  UserChannelIdentityLink,
  UserChannelIdentityResult,
  UserChannelIdentitySelector,
  UserChannelIdentityWorkerOperations,
} from "./user-profiles.types.js";

type IdentityOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

function captureAuthorityContext(options: IdentityOptions) {
  if (getActiveOpenClawStateDatabaseReadSnapshot(options)) {
    throw new Error("Profile authority requires live state, not a discovery snapshot");
  }
  return captureOpenClawStateWorkerContext(options);
}

function unwrapIdentityResult<T>(result: UserChannelIdentityResult<T>, profileId: string): T {
  if (result.ok) {
    return result.value;
  }
  switch (result.kind) {
    case "conflict":
      throw new UserChannelIdentityConflictError();
    case "not-found":
      throw new UserProfileNotFoundError(profileId);
    case "owner":
      throw new UserProfileOwnerError(result.code);
  }
  result satisfies never;
  throw new Error("Unsupported channel identity result");
}

export async function listCanonicalUserChannelIdentities(
  profileId: string,
  options: IdentityOptions = {},
): Promise<UserChannelIdentityLink[]> {
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "userProfiles.channelIdentity.list",
    profileId,
  });
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "userProfiles.channelIdentity.list") {
    throw new Error("Channel identity reader returned an unexpected result");
  }
  return unwrapIdentityResult(reply.result, profileId);
}

type IdentityChange =
  UserChannelIdentityWorkerOperations["userProfiles.channelIdentity.change"]["input"];

async function changeIdentity(
  input: IdentityChange,
  options: IdentityOptions & { assertCurrent?: () => void } = {},
) {
  const captured = structuredClone(input);
  const subject =
    "identity" in captured ? userChannelIdentitySubject(captured.identity) : undefined;
  const assertCurrent = options.assertCurrent;
  const context = captureOpenClawStateWorkerContext(options);
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "userProfiles.channelIdentity.change",
        input: captured,
      }),
    {
      assertCurrent,
      createAdmission: (operation) => {
        let fence: ReturnType<typeof fenceUserProfileMutationAuthority> | undefined;
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          if (
            (request.stage !== "transaction" && request.stage !== "commit") ||
            !isRecord(request.facts) ||
            request.facts.kind !== "channel-identity" ||
            request.facts.action !== captured.action ||
            request.facts.subject !== subject ||
            !Array.isArray(request.facts.profiles) ||
            !request.facts.profiles.every(
              (profileId): profileId is string => typeof profileId === "string",
            ) ||
            !Array.isArray(request.facts.channels) ||
            !request.facts.channels.every(
              (channel): channel is string => typeof channel === "string",
            )
          ) {
            throw new Error("Channel identity mutation requires exact transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          if (request.stage === "commit" && captured.action !== "authorize") {
            fence ??= fenceUserProfileMutationAuthority(context.admission, {
              profiles: request.facts.profiles,
              identities: [],
              channels: request.facts.channels,
            });
          }
          grant();
        });
        void operation.settled.then((settlement) => {
          const committed = admission.committed;
          if (
            captured.action !== "authorize" &&
            committed &&
            isRecord(committed.facts) &&
            committed.facts.kind === "channel-identity" &&
            committed.facts.subject === subject
          ) {
            publishUserProfileAliasChange();
            emitUserProfilesChanged();
          }
          fence?.settle(settlement.kind !== "unknown");
        });
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    },
  );
  return unwrapIdentityResult(result, "profileId" in captured ? captured.profileId : "");
}

export async function changeCanonicalUserChannelIdentity(
  action: "link" | "unlink",
  profileId: string,
  identity: UserChannelIdentity,
  options: IdentityOptions & { assertCurrent?: () => void } = {},
) {
  const result = await changeIdentity({ action, profileId, identity }, options);
  if (result.kind !== "linked" && result.kind !== "unlinked") {
    throw new Error("Unexpected channel identity change");
  }
  return result;
}

export async function publishCanonicalUserChannelPolicy(
  gateway: Parameters<typeof resolveUserChannelAuthorizationPolicy>[0],
  configuredOwners?: readonly (string | number)[],
) {
  await changeIdentity({
    action: "policy",
    policy: resolveUserChannelAuthorizationPolicy(gateway),
    configuredOwnersHash: configuredCommandOwnerPolicyFingerprint(configuredOwners),
  });
}

/** The existing policy publication fence qualifies this read without inventing a person link. */
export async function prepareConfiguredCommandOwnerAuthority(
  owners: readonly (string | number)[] | undefined,
  options: IdentityOptions = {},
) {
  const fingerprint = configuredCommandOwnerPolicyFingerprint(owners);
  if (!fingerprint) {
    return undefined;
  }
  const context = captureAuthorityContext(options);
  const read = await captureUserProfileAuthorityRead(
    context.admission,
    "operator.channelPolicy",
    "authority",
    (db) => readConfigMachineStateRowInDatabase(db, "operator.channelPolicy")?.value_json,
  );
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "operator.channelPolicy" },
  );
  context.admission.assertCurrent();
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "operator.channelPolicy") {
    throw new Error("Configured command owner reader returned an unexpected result");
  }
  const recoveryReference =
    reply.row && readConfiguredCommandOwnerPolicy(JSON.parse(reply.row.value_json), fingerprint);
  if (!recoveryReference) {
    return undefined;
  }
  const isCurrent = read.bind([], undefined, (value) => value === reply.row?.value_json);
  if (!isCurrent) {
    throw new Error("Configured command owner policy changed during preparation");
  }
  return { recoveryReference, isCurrent };
}

export async function authorizeCanonicalUserChannelIdentity(
  input: Extract<IdentityChange, { action: "authorize" }>,
  options: IdentityOptions & { assertCurrent: () => void },
) {
  const result = await changeIdentity(input, options);
  if (result.kind !== "authorized") {
    throw new Error("Unexpected channel authorization result");
  }
  return result.reference;
}

/** Qualify worker-read facts against the same physical profile owner's mutation lifetime. */
export async function prepareUserChannelIdentityAuthority(
  identity: UserChannelIdentitySelector,
  options: IdentityOptions = {},
) {
  const capturedIdentity = structuredClone(identity);
  const subject =
    "authorizationId" in capturedIdentity
      ? undefined
      : userChannelIdentitySubject(capturedIdentity);
  const context = captureAuthorityContext(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await captureUserProfileAuthorityRead(
      context.admission,
      subject,
      "authority",
      (db) => ({
        linked: resolveUserChannelIdentityInDatabase(db, capturedIdentity),
        policy: readConfigMachineStateRowInDatabase(db, "operator.channelPolicy")?.value_json,
      }),
    );
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      {
        type: "userProfiles.channelIdentity.resolve",
        identity: capturedIdentity,
      },
    );
    context.admission.assertCurrent();
    if (!reply) {
      return undefined;
    }
    if (!reply.ok || reply.type !== "userProfiles.channelIdentity.resolve") {
      throw new Error("Channel authority reader returned an unexpected result");
    }
    if (!reply.linked) {
      return undefined;
    }
    const isCurrent = read.bind(
      reply.linked.profileId,
      reply.linked.authorization?.subject ?? subject,
      (facts) => isDeepStrictEqual(facts.linked, reply.linked),
    );
    if (isCurrent) {
      return { linked: reply.linked, isCurrent };
    }
  }
  throw new Error("Profile authority changed while preparing the channel request");
}

export async function prepareUserProfileRoleAuthority(
  profileId: string,
  options: IdentityOptions = {},
) {
  return prepareUserProfileAuthority(profileId, options, "authority");
}

export async function prepareUserProfileSelectionAuthority(
  profileId: string,
  options: IdentityOptions = {},
) {
  const prepared = await prepareUserProfileAuthority(profileId, options, "identity");
  return prepared && { profileId: prepared.profileId, isCurrent: prepared.isCurrent };
}

async function prepareUserProfileAuthority(
  profileId: string,
  options: IdentityOptions,
  dependency: "authority" | "identity",
) {
  const context = captureAuthorityContext(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await captureUserProfileAuthorityRead(
      context.admission,
      undefined,
      dependency,
      (db) => readUserProfileAuthorityFingerprint(db, profileId, dependency),
    );
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      {
        type: "userProfiles.authority.resolve",
        profileId,
      },
    );
    context.admission.assertCurrent();
    if (!reply) {
      return undefined;
    }
    if (!reply.ok || reply.type !== "userProfiles.authority.resolve") {
      throw new Error("Profile authority reader returned an unexpected result");
    }
    if (!reply.profile) {
      return undefined;
    }
    const profile = reply.profile;
    const isCurrent = read.bind(
      [profileId, profile.profileId],
      undefined,
      (facts) =>
        facts?.profileId === profile.profileId &&
        (dependency === "identity" ||
          ("role" in facts &&
            facts.role === profile.role &&
            isDeepStrictEqual(facts.aliases, new Set(profile.aliases)))),
    );
    if (isCurrent) {
      return { ...reply.profile, isCurrent };
    }
  }
  throw new Error("Profile authority changed while preparing the administrative request");
}

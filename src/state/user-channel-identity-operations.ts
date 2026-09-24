import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
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
} from "./user-channel-identities.js";
import {
  captureUserProfileAuthorityRead,
  emitUserProfilesChanged,
  fenceUserProfileMutationAuthority,
  publishUserProfileAliasChange,
} from "./user-profile-events.js";
import { UserProfileNotFoundError, UserProfileOwnerError } from "./user-profiles-schema.js";
import type {
  UserChannelIdentity,
  UserChannelIdentityLink,
  UserChannelIdentityResult,
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

export async function changeCanonicalUserChannelIdentity(
  action: "link" | "unlink",
  profileId: string,
  identity: UserChannelIdentity,
  options: IdentityOptions & { assertCurrent?: () => void } = {},
) {
  const capturedIdentity = { ...identity };
  const subject = userChannelIdentitySubject(capturedIdentity);
  const assertCurrent = options.assertCurrent;
  const context = captureOpenClawStateWorkerContext(options);
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "userProfiles.channelIdentity.change",
        input: { action, profileId, identity: capturedIdentity },
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
            request.facts.subject !== subject
          ) {
            throw new Error("Channel identity mutation requires exact transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          if (request.stage === "commit") {
            fence ??= fenceUserProfileMutationAuthority(context.admission, {
              profiles: [],
              identities: [],
              channels: [subject],
            });
          }
          grant();
        });
        void operation.settled.then((settlement) => {
          const committed = admission.committed;
          if (
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
  return unwrapIdentityResult(result, profileId);
}

/** Qualify worker-read facts against the same physical profile owner's mutation lifetime. */
export async function prepareUserChannelIdentityAuthority(
  identity: UserChannelIdentity,
  options: IdentityOptions = {},
) {
  const capturedIdentity = { ...identity };
  const subject = userChannelIdentitySubject(capturedIdentity);
  const context = captureAuthorityContext(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await captureUserProfileAuthorityRead(context.admission, subject);
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
    const isCurrent = read.bind(reply.linked.profileId);
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
    const read = await captureUserProfileAuthorityRead(context.admission, undefined, dependency);
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
    const isCurrent = read.bind([profileId, reply.profile.profileId]);
    if (isCurrent) {
      return { ...reply.profile, isCurrent };
    }
  }
  throw new Error("Profile authority changed while preparing the administrative request");
}

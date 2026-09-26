import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { getExistingOpenClawStateSchemaPath } from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { profileCatalogPath } from "./user-profile-identity.read.js";
import { retainUserProfilePublication } from "./user-profile-list.js";
import {
  isUserProfileAvatarAdmission,
  type UserProfileAvatar,
  type UserProfileAvatarInspection,
} from "./user-profiles-avatar.types.js";
import { UserProfileNotFoundError } from "./user-profiles-schema.js";
import {
  fetchTailscaleAvatar,
  type TailscaleAvatarFetchOptions,
} from "./user-profiles-tailscale-avatar.js";
import type { UserProfile } from "./user-profiles.types.js";

type PreparedProfileAvatar = UserProfileAvatarInspection & {
  isCurrent(): boolean;
  loadBytes(): Promise<UserProfileAvatar | undefined>;
};

type ProfileAvatarReader = { inspect(): Promise<PreparedProfileAvatar> };
const pendingReaders = new Map<string, ProfileAvatarReader>();

/** Keep every refresh and materialization bound to the original physical store. */
export function createProfileAvatarReader(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ProfileAvatarReader {
  // Explicit environments and maintenance/schema scopes retain their caller's admission.
  const key =
    options.env ||
    options.database ||
    getOpenClawDatabaseMaintenanceScope() ||
    getExistingOpenClawStateSchemaPath()
      ? undefined
      : JSON.stringify([profileCatalogPath(options), profileId]);
  const pending = key && pendingReaders.get(key);
  if (pending) {
    return pending;
  }
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const location = { path: context.admission.databasePath, env: context.environment };
  let inspection: Promise<PreparedProfileAvatar> | undefined;
  const reader: ProfileAvatarReader = {
    inspect() {
      if (!inspection) {
        if (key) {
          pendingReaders.set(key, reader);
        }
        inspection = inspect().finally(() => {
          inspection = undefined;
          if (key && pendingReaders.get(key) === reader) {
            pendingReaders.delete(key);
          }
        });
      }
      return inspection;
    },
  };
  async function inspect(): Promise<PreparedProfileAvatar> {
    for (;;) {
      const revision = readUserProfileVersion();
      const reply = await executeExistingOpenClawStateRead(
        location,
        { type: "userProfiles.avatar.inspect", profileId },
        { context, current: true },
      );
      context.admission.assertCurrent();
      if (reply && (!reply.ok || reply.type !== "userProfiles.avatar.inspect")) {
        throw new Error("Unexpected profile avatar inspection result");
      }
      if (revision !== readUserProfileVersion()) {
        continue;
      }
      const snapshot: UserProfileAvatarInspection = reply?.inspection ?? {
        profile: undefined,
        hasAvatar: false,
        emails: [],
      };
      const isCurrent = () => {
        context.admission.assertCurrent();
        return revision === readUserProfileVersion();
      };
      let bytes: Promise<UserProfileAvatar | undefined> | undefined;
      const readBytes = async () => {
        const { profile, avatar } = snapshot;
        if (!profile || !avatar || !isCurrent()) {
          return undefined;
        }
        const result = await executeExistingOpenClawStateRead(
          location,
          {
            type: "userProfiles.avatar.read",
            profileId,
            expected: { canonicalProfileId: profile.id, sha256: avatar.sha256, mime: avatar.mime },
          },
          { context, current: true },
        );
        if (result && (!result.ok || result.type !== "userProfiles.avatar.read")) {
          throw new Error("Unexpected profile avatar materialization result");
        }
        return isCurrent() ? result?.avatar : undefined;
      };
      return {
        ...snapshot,
        isCurrent,
        loadBytes: () =>
          (bytes ??= readBytes().finally(() => {
            bytes = undefined;
          })),
      };
    }
  }
  return reader;
}

function requireAvatarProfile(profile: UserProfile | undefined, profileId: string): UserProfile {
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profile;
}

/** Best-effort avatar adoption runs after authentication so remote I/O cannot delay login. */
export async function adoptTailscaleProfileAvatar(
  profileId: string,
  profilePic: string | undefined,
  options: OpenClawStateDatabaseOptions = {},
  fetchOptions: TailscaleAvatarFetchOptions = {},
) {
  const first = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const { executeOpenClawStateWorker, runOpenClawStateWorkerOperation } =
    await import("./openclaw-state-worker-store.js");
  const before = await executeOpenClawStateWorker(first, {
    type: "userProfiles.avatar.inspect",
    input: { profileId },
  });
  const initial = requireAvatarProfile(before.profile, profileId);
  if (before.hasAvatar || !profilePic) {
    return initial;
  }
  const avatar = await fetchTailscaleAvatar(profilePic, fetchOptions);
  // Fetching does not retain database admission; close/reopen preserves the selected path.
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: first.admission.databasePath,
  });
  if (!avatar) {
    return requireAvatarProfile(
      (
        await executeOpenClawStateWorker(context, {
          type: "userProfiles.avatar.inspect",
          input: { profileId },
        })
      ).profile,
      profileId,
    );
  }
  const [{ withOpenClawStateSettlementRead }, { createSqliteWorkerOperationAdmission }] =
    await Promise.all([
      import("./openclaw-state-settlement-read.js"),
      import("../infra/sqlite-worker-operation-admission.js"),
    ]);
  return await withOpenClawStateSettlementRead(context, async (settlementRead) =>
    runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const receipt = await scope.execute({
          type: "userProfiles.avatar.adopt",
          input: { profileId, bytes: avatar.bytes, mime: avatar.mime, now: Date.now() },
        });
        settlementRead.acknowledge(receipt.committed);
        return requireAvatarProfile(receipt.profile, profileId);
      },
      {
        requireStateLifecycle: true,
        createAdmission(retained) {
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              context.admission.assertCurrent();
              if (request.stage !== "transaction" || !isUserProfileAvatarAdmission(request.facts)) {
                throw new Error("Unexpected profile avatar transaction admission");
              }
              const publication = retainUserProfilePublication(
                context.admission.identity,
                request.facts.before.id,
                request.facts.before,
              );
              try {
                settlementRead.bind(
                  { type: "userProfiles.reconcile", profileId: request.facts.before.id },
                  retained.settled,
                  publication.reconcile,
                  publication.release,
                );
              } catch (error) {
                publication.release();
                throw error;
              }
              grant();
            }),
          };
        },
      },
    ),
  );
}

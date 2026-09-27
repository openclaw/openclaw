import pLimit from "p-limit";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { getExistingOpenClawStateSchemaPath } from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import { profileCatalogPath } from "./user-profile-identity.read.js";
import {
  readResidentUserProfileRevision,
  retainUserProfilePublication,
} from "./user-profile-list.js";
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
import type { ProfileDisplayRow, UserProfile } from "./user-profiles.types.js";

type PreparedProfileAvatar = UserProfileAvatarInspection & {
  isCurrent(): boolean;
  loadBytes(): Promise<UserProfileAvatar | undefined>;
};

type ProfileAvatarReader = { inspect(): Promise<PreparedProfileAvatar> };
const pendingReaders = new Map<string, ProfileAvatarReader>();
const avatarReads = pLimit(4);
const avatarCache = new Map<ProfileDisplayRow, PreparedProfileAvatar>();
let avatarCacheBytes = 0;

function evictAvatar(revision: ProfileDisplayRow, avatar: PreparedProfileAvatar) {
  avatarCache.delete(revision);
  avatarCacheBytes -= avatar.avatar?.byteLength ?? 0;
}

function currentAvatar(avatar: PreparedProfileAvatar) {
  try {
    return avatar.isCurrent();
  } catch {
    // Database retirement ends the admission captured by the cached read.
    return false;
  }
}

onUserProfilesChanged(() => {
  for (const [revision, avatar] of avatarCache) {
    if (!currentAvatar(avatar)) {
      evictAvatar(revision, avatar);
    }
  }
});

function cacheAvatar(revision: ProfileDisplayRow, avatar: PreparedProfileAvatar) {
  const previous = avatarCache.get(revision);
  if (previous) {
    evictAvatar(revision, previous);
  }
  avatarCache.set(revision, avatar);
  // Reserve the advertised bytes even for HEAD/304 so later materialization stays bounded.
  avatarCacheBytes += avatar.avatar?.byteLength ?? 0;
  for (const [oldest, value] of avatarCache) {
    if (avatarCache.size <= 128 && avatarCacheBytes <= 16 * 1024 * 1024) {
      break;
    }
    evictAvatar(oldest, value);
  }
}

async function readAvatar<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (avatarReads.pendingCount >= 128) {
    throw new WorkerTaskError("Profile avatar read queue is full", "overloaded");
  }
  const signal = AbortSignal.timeout(5_000);
  try {
    return await racePromiseWithAbortSignal(
      avatarReads(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
      signal,
    );
  } catch (error) {
    if (signal.aborted) {
      throw new WorkerTaskError("Profile avatar read budget expired", "timeout");
    }
    throw error;
  }
}

/** Keep every refresh and materialization bound to the original physical store. */
export function createProfileAvatarReader(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ProfileAvatarReader {
  // Explicit environments and maintenance/schema scopes retain their caller's admission.
  const pathname = profileCatalogPath(options);
  const share = !(
    options.env ||
    options.database ||
    getOpenClawDatabaseMaintenanceScope() ||
    getExistingOpenClawStateSchemaPath()
  );
  const residentRevision = () =>
    share ? readResidentUserProfileRevision(profileId, pathname) : undefined;
  const key = share ? JSON.stringify([pathname, profileId]) : undefined;
  const pending = key && pendingReaders.get(key);
  if (pending) {
    return pending;
  }
  let context = share
    ? undefined
    : captureOpenClawStateWorkerContext({
        ...options,
        path: options.database?.path ?? pathname,
      });
  const readContext = context ?? captureOpenClawStateReadContext(pathname);
  let inspection: Promise<PreparedProfileAvatar> | undefined;
  const reader: ProfileAvatarReader = {
    inspect() {
      readContext.admission.assertCurrent();
      const revision = residentRevision();
      const cached = revision && avatarCache.get(revision);
      if (cached) {
        if (currentAvatar(cached)) {
          avatarCache.delete(revision);
          avatarCache.set(revision, cached);
          return Promise.resolve({
            ...cached,
            isCurrent() {
              readContext.admission.assertCurrent();
              return cached.isCurrent() && revision === residentRevision();
            },
          });
        }
        evictAvatar(revision, cached);
      }
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
    const captured = (context ??= {
      ...captureOpenClawStateWorkerContext({ path: pathname }),
      ...readContext,
    });
    const location = { path: captured.admission.databasePath, env: captured.environment };
    for (;;) {
      const revision = readUserProfileVersion();
      const row = residentRevision();
      const reply = await readAvatar((signal) =>
        executeExistingOpenClawStateRead(
          location,
          { type: "userProfiles.avatar.inspect", profileId },
          { context: captured, current: true, signal },
        ),
      );
      captured.admission.assertCurrent();
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
        captured.admission.assertCurrent();
        return row ? row === residentRevision() : revision === readUserProfileVersion();
      };
      let bytes: Promise<UserProfileAvatar | undefined> | undefined;
      const readBytes = async () => {
        const { profile, avatar } = snapshot;
        if (!profile || !avatar || !isCurrent()) {
          return undefined;
        }
        const result = await readAvatar((signal) =>
          executeExistingOpenClawStateRead(
            location,
            {
              type: "userProfiles.avatar.read",
              profileId,
              expected: {
                canonicalProfileId: profile.id,
                sha256: avatar.sha256,
                mime: avatar.mime,
              },
            },
            { context: captured, current: true, signal },
          ),
        );
        if (result && (!result.ok || result.type !== "userProfiles.avatar.read")) {
          throw new Error("Unexpected profile avatar materialization result");
        }
        return isCurrent() ? result?.avatar : undefined;
      };
      const prepared: PreparedProfileAvatar = {
        ...snapshot,
        isCurrent,
        loadBytes() {
          if (!isCurrent()) {
            return Promise.resolve(undefined);
          }
          return (bytes ??= readBytes().then(
            (avatar) => {
              if (!avatar && row && avatarCache.get(row) === prepared) {
                evictAvatar(row, prepared);
              }
              if (!avatar || !row || avatarCache.get(row) !== prepared) {
                bytes = undefined;
              }
              return avatar;
            },
            (error: unknown) => {
              bytes = undefined;
              throw error;
            },
          ));
        },
      };
      if (
        row &&
        snapshot.avatar &&
        snapshot.profile?.id === row.id &&
        snapshot.avatar.sha256 === row.avatar_sha256 &&
        snapshot.avatar.mime === row.avatar_mime
      ) {
        cacheAvatar(row, prepared);
      }
      return prepared;
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

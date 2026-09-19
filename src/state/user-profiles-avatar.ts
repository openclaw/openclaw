import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { retainUserProfilePublication } from "./user-profile-list.js";
import { isUserProfileAvatarAdmission } from "./user-profiles-avatar.types.js";
import type { UserProfile } from "./user-profiles-internal.js";
import { UserProfileNotFoundError } from "./user-profiles-schema.js";
import {
  fetchTailscaleAvatar,
  type TailscaleAvatarFetchOptions,
} from "./user-profiles-tailscale-avatar.js";

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
                request.facts.before,
                retained.settled,
              );
              try {
                settlementRead.bind(
                  { type: "userProfiles.reconcile", profileId: request.facts.before.id },
                  retained.settled,
                  publication,
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

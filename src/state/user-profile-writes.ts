import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import {
  emitUserProfilesChanged,
  fenceUserProfileMutationAuthority,
  publishUserProfileAliasChange,
} from "./user-profile-events.js";
import { retainUserProfileMutationPublication } from "./user-profile-list.js";
import {
  isUserProfileMutationPublication,
  type UserProfileMutationPublication,
} from "./user-profile-mutation.js";
import type {
  UserProfileWriteOperations,
  UserProfileWriteResult,
} from "./user-profile-writes.worker.js";
import { UserProfileNotFoundError, UserProfileOwnerError } from "./user-profiles-schema.js";

type ProfileWriteOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
  assertCurrent?: () => void;
};

function unwrap<T>(result: UserProfileWriteResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  if (result.kind === "not-found") {
    throw new UserProfileNotFoundError(result.profileId);
  }
  throw new UserProfileOwnerError(result.code);
}

async function write<Key extends keyof UserProfileWriteOperations>(
  type: Key,
  input: UserProfileWriteOperations[Key]["input"],
  options: ProfileWriteOptions,
): Promise<UserProfileWriteOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = options.assertCurrent;
  const captured = structuredClone(input);
  let publicationSettled: Promise<void> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type, input: captured }),
      {
        assertCurrent,
        createAdmission: (operation) => {
          let inTransaction = false;
          const pending = new Map<
            number,
            {
              facts: UserProfileMutationPublication;
              publication: ReturnType<typeof retainUserProfileMutationPublication>;
              fence: ReturnType<typeof fenceUserProfileMutationAuthority>;
              granted: boolean;
              published: boolean;
            }
          >();
          const publishCommitted = () => {
            const receipt = admission.committed?.facts;
            if (receipt === undefined) {
              return;
            }
            if (
              !isRecord(receipt) ||
              receipt.kind !== "user-profile-commits" ||
              !Array.isArray(receipt.publications) ||
              receipt.publications.length === 0 ||
              !receipt.publications.every(isUserProfileMutationPublication)
            ) {
              throw new Error("Profile mutation returned an invalid commit receipt");
            }
            for (const [index, facts] of receipt.publications.entries()) {
              const entry = pending.get(facts.sequence);
              if (
                !entry ||
                facts.sequence !== index + 1 ||
                !isDeepStrictEqual(entry.facts, facts)
              ) {
                throw new Error("Profile mutation receipt changed its prepared publication");
              }
              if (entry.published) {
                continue;
              }
              entry.publication.reconcile(facts.after);
              if (facts.changes.identities.length || facts.changes.channels.length) {
                publishUserProfileAliasChange();
              }
              if (facts.changes.profiles.length && isDeepStrictEqual(facts.before, facts.after)) {
                emitUserProfilesChanged();
              }
              entry.published = true;
              entry.fence.settle(true);
            }
          };
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            publishCommitted();
            context.admission.assertCurrent();
            assertCurrent?.();
            if (
              request.stage === "transaction" &&
              isRecord(request.facts) &&
              request.facts.kind === "user-profile-write" &&
              request.facts.operation === type
            ) {
              if (inTransaction) {
                throw new Error("Profile mutation requested overlapping transactions");
              }
              inTransaction = grant();
              return;
            }
            if (
              !inTransaction ||
              request.stage !== "commit" ||
              !isUserProfileMutationPublication(request.facts) ||
              pending.has(request.facts.sequence)
            ) {
              throw new Error(
                "Profile mutation requires its exact transaction and commit admission",
              );
            }
            const facts = request.facts;
            const publication = retainUserProfileMutationPublication(
              context.admission.identity,
              facts.before,
            );
            const fence = fenceUserProfileMutationAuthority(context.admission, facts.changes);
            const entry = { facts, publication, fence, granted: false, published: false };
            pending.set(facts.sequence, entry);
            entry.granted = grant();
            inTransaction = false;
          });
          publicationSettled = operation.settled.then((settlement) => {
            let receiptsValid = false;
            try {
              publishCommitted();
              receiptsValid = true;
            } finally {
              for (const entry of pending.values()) {
                const known =
                  entry.published ||
                  !entry.granted ||
                  (receiptsValid && settlement.kind === "completed");
                if (!entry.published && entry.granted) {
                  if (known) {
                    entry.publication.reconcile(entry.facts.before);
                  } else {
                    entry.publication.invalidate();
                  }
                }
                entry.fence.settle(known);
                entry.publication.release();
              }
            }
          });
          void publicationSettled.catch(() => undefined);
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
  } finally {
    // Caller revocation cannot discard a committed mutation or its catalog publication.
    await publicationSettled;
  }
}

export async function setCanonicalUserProfileRole(
  profileId: string,
  role: string | null,
  options: ProfileWriteOptions = {},
) {
  return unwrap(await write("userProfiles.setRole", { profileId, role }, options));
}
export async function linkCanonicalUserProfileEmail(
  email: string,
  targetProfileId: string,
  options: ProfileWriteOptions = {},
) {
  return unwrap(await write("userProfiles.linkEmail", { email, targetProfileId }, options));
}
export async function ensureCanonicalUserProfileForEmail(
  email: string,
  options: ProfileWriteOptions = {},
) {
  return unwrap(await write("userProfiles.ensureEmail", { email }, options));
}
export async function ensureCanonicalUserProfileForTailscaleIdentity(
  identity: UserProfileWriteOperations["userProfiles.ensureTailscale"]["input"],
  options: ProfileWriteOptions = {},
) {
  return unwrap(await write("userProfiles.ensureTailscale", identity, options));
}
export async function syncCanonicalGitHubIdentity(
  input: UserProfileWriteOperations["userProfiles.syncGitHub"]["input"],
  options: ProfileWriteOptions = {},
) {
  return unwrap(await write("userProfiles.syncGitHub", input, options));
}
export async function ensureCanonicalGatewayOwnerProfile(
  displayName: string | null,
  options: ProfileWriteOptions = {},
) {
  return unwrap(await write("userProfiles.ensureOwner", { displayName }, options));
}

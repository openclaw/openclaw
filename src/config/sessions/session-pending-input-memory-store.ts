import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputRead,
} from "./session-pending-input-operations.types.js";

/** Handle-local drainage; pending input and completion state stay in the actor. */
export function prepareMemoryPendingInputStore(
  binding: SessionActorStorageBinding,
  assertCurrent: () => void,
  releaseActor?: () => Promise<void>,
) {
  const storage = binding.actor.storage!;
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let active = true;
  let actorRelease: Promise<void> | undefined;
  const releaseOwner = () => (actorRelease ??= releaseActor?.() ?? Promise.resolve());
  let revokeCustody = () => {};
  const assertOpen = () => {
    if (!active) {
      throw new Error("Pending input actor handle has closed");
    }
    try {
      binding.actor.assertCurrent();
    } catch (error) {
      active = false;
      revokeCustody();
      throw error;
    }
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        failures.push(error);
        pending.delete(operation);
      },
    );
    return operation;
  };
  const settled = async () => {
    while (pending.size) {
      await Promise.allSettled(pending);
    }
    if (failures.length) {
      throw failures[0];
    }
  };
  const authority: SessionActorStorageAuthority = {
    ...binding.authority,
    assertCurrent() {
      assertOpen();
      binding.authority.assertCurrent();
      assertCurrent();
    },
  };
  return {
    sessionActor: binding,
    assertCurrent: assertOpen,
    withAdmission<T>(operation: () => Promise<T>, _reentrant: boolean): Promise<T> {
      assertOpen();
      return operation();
    },
    sessionKey: binding.actor.target.sessionKey,
    databaseAgentId: binding.agentId,
    path: binding.path,
    workerDatabasePath: binding.path,
    bindCustody(revoke: () => void) {
      revokeCustody = revoke;
    },
    settled,
    retire(operation: Promise<void>) {
      void track(
        (async () => {
          try {
            await operation;
          } finally {
            await releaseOwner();
          }
        })(),
      );
    },
    async release() {
      try {
        await settled();
      } finally {
        active = false;
        await releaseOwner();
      }
    },
    read(input: PendingInputRead) {
      return track(storage.read({ type: "session.pendingInput.read", input }, authority));
    },
    nativeMutation(): never {
      throw new IncognitoSessionSyncAccessError("complete", "completeAsync");
    },
    mutate(
      input: PendingInputMutation,
      guard: (stage: "transaction" | "commit", facts?: PendingInputCustodyGrant) => void,
      publish?: (
        facts: PendingInputCustodyGrant | undefined,
        assertSourceCurrent: () => void,
      ) => void,
    ) {
      return track(
        (async () => {
          let committedFacts: PendingInputCustodyGrant | undefined;
          const outcome = await storage.mutate(
            { type: "session.pendingInput.mutate", input },
            {
              ...authority,
              authorize(stage, hot, publication) {
                binding.authority.authorize(stage, hot, publication);
                if (
                  isRecord(publication) &&
                  publication.kind === "pending-input-settlement-custody"
                ) {
                  // SAFETY: The memory pending owner publishes its typed custody grant under this kind.
                  committedFacts = publication as PendingInputCustodyGrant;
                  guard(stage, committedFacts);
                }
              },
            },
            { committed: () => publish?.(committedFacts, assertOpen) },
          );
          return readSessionActorStorageResult(outcome);
        })(),
      );
    },
  };
}

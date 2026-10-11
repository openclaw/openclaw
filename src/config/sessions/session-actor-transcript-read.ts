import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import type { SessionActor } from "./session-actor-contract.js";
import type { SessionActorMemoryHistoryReads } from "./session-actor-memory-history-contract.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

/** Capture the selected memory namespace; borrowed sibling handles never create a backend. */
export function captureSessionActorTranscriptRead(
  scope: SessionTranscriptReadScope,
  signal?: AbortSignal,
) {
  const namespace = captureSessionActorStorageOwner(scope, {
    assertCurrent: () => signal?.throwIfAborted(),
    authorize: () => signal?.throwIfAborted(),
  });
  if (!namespace) {
    return undefined;
  }
  const selected = namespace.binding;
  const sameOwner =
    selected && namespace.agentId === selected.agentId && namespace.path === selected.path;
  const stored = sameOwner
    ? selected.actor.storage!.readCurrent(
        { type: "session.entry.readById", input: { sessionId: scope.sessionId } },
        selected.authority,
      )
    : namespace.owner?.readSessionById(scope.sessionId, namespace.authority);
  const sessionKey = stored?.sessionKey ?? scope.sessionKey ?? "";
  const direct = sameOwner && sessionKey === selected.actor.target.sessionKey;
  const target = captureSessionTranscriptTargetBinding({
    agentId: namespace.agentId,
    sessionKey,
    sessionId: scope.sessionId,
    storePath: sameOwner ? selected.path : namespace.path,
    env: scope.env,
  });
  const receipt = resolveSessionTranscriptReadFence(target);
  const admission = receipt && structuredClone(receipt);
  const assertOwnerCurrent = namespace.owner?.captureSessionReadGuard(sessionKey);
  const authority = {
    ...namespace.authority,
    assertCurrent: () => {
      signal?.throwIfAborted();
      assertOwnerCurrent?.();
      selected?.actor.assertReadable();
      namespace.authority.assertCurrent();
    },
  };
  return {
    target,
    missing: !stored,
    currentEntry() {
      authority.assertCurrent();
      return sameOwner
        ? selected.actor.storage!.readCurrent(
            { type: "session.entry.read", input: { sessionKey } },
            selected.authority,
          )
        : namespace.owner?.readSession(sessionKey, namespace.authority)?.entry;
    },
    assertCurrent: authority.assertCurrent,
    async read<Key extends keyof SessionActorMemoryHistoryReads>(
      type: Key,
      input: SessionActorMemoryHistoryReads[Key]["input"],
    ): Promise<SessionActorMemoryHistoryReads[Key]["output"]> {
      authority.assertCurrent();
      if (!stored) {
        throw new Error("Session transcript window is unavailable");
      }
      let actor: SessionActor | undefined;
      try {
        actor = direct
          ? selected.actor
          : sameOwner
            ? await selected.actor.storage!.acquire(sessionKey)
            : await namespace.owner?.acquireExisting(sessionKey, {
                assertCurrent: authority.assertCurrent,
                assertReadable: authority.assertCurrent,
              });
        if (!actor) {
          throw new Error("Session transcript window is unavailable");
        }
        return await actor.storage!.read(
          { type, input: { admission, ...input, sessionId: target.sessionId } },
          authority,
        );
      } finally {
        if (actor && !direct) {
          await actor.release();
        }
      }
    },
  };
}

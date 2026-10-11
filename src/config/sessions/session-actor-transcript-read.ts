import path from "node:path";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import type { SessionActor } from "./session-actor-contract.js";
import type { SessionActorMemoryHistoryReads } from "./session-actor-memory-history-contract.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

/** Capture the selected memory namespace; borrowed sibling handles never create a backend. */
export function captureSessionActorTranscriptRead(
  scope: SessionTranscriptReadScope,
  signal?: AbortSignal,
) {
  if (scope.sessionKey && !isIncognitoSessionKey(scope.sessionKey)) {
    return undefined;
  }
  const selected = getSessionActorStorageBinding({});
  if (!selected) {
    return undefined;
  }
  const agentId =
    scope.agentId ??
    (scope.sessionKey ? resolveAgentIdFromSessionKey(scope.sessionKey) : selected.agentId);
  const sameOwner = agentId === selected.agentId;
  if (sameOwner) {
    getSessionActorStorageBinding({ ...scope, sessionKey: undefined });
  }
  const stored = sameOwner
    ? selected.actor.storage!.readCurrent(
        { type: "session.entry.readById", input: { sessionId: scope.sessionId } },
        selected.authority,
      )
    : undefined;
  const sessionKey = stored?.sessionKey ?? scope.sessionKey ?? "";
  const direct = sameOwner && sessionKey === selected.actor.target.sessionKey;
  const target = captureSessionTranscriptTargetBinding({
    agentId,
    sessionKey,
    sessionId: scope.sessionId,
    storePath: sameOwner
      ? selected.path
      : resolveIncognitoOpenClawAgentSqlitePath({
          agentId,
          env: { OPENCLAW_STATE_DIR: path.resolve(selected.path, "../../../..") },
        }),
    env: scope.env,
  });
  const receipt = resolveSessionTranscriptReadFence(target);
  const admission = receipt && structuredClone(receipt);
  const authority = {
    ...selected.authority,
    assertCurrent: () => {
      signal?.throwIfAborted();
      selected.authority.assertCurrent();
    },
  };
  return {
    target,
    missing: !stored,
    currentEntry() {
      return sameOwner
        ? selected.actor.storage!.readCurrent(
            { type: "session.entry.read", input: { sessionKey } },
            selected.authority,
          )
        : undefined;
    },
    assertCurrent: () => {
      signal?.throwIfAborted();
      selected.actor.assertReadable();
      selected.authority.assertCurrent();
    },
    async read<Key extends keyof SessionActorMemoryHistoryReads>(
      type: Key,
      input: SessionActorMemoryHistoryReads[Key]["input"],
    ): Promise<SessionActorMemoryHistoryReads[Key]["output"]> {
      signal?.throwIfAborted();
      if (!stored) {
        throw new Error("Session transcript window is unavailable");
      }
      let actor: SessionActor | undefined;
      try {
        actor = direct ? selected.actor : await selected.actor.storage!.acquire(sessionKey);
        return await actor.storage!.read(
          { type, input: { ...input, sessionId: target.sessionId, admission } },
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

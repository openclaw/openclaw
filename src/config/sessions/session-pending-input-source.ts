import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import type { PendingInputSourceSnapshot } from "./session-pending-input-operations.types.js";
import type { PendingInputScope } from "./session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

async function readPendingInputSource<T>(
  scope: PendingInputScope,
  idempotencyKey: string,
  pendingOnly: boolean,
  consume: (snapshot: PendingInputSourceSnapshot) => T,
) {
  const sessionId = scope.sessionId;
  const sessionKey = scope.sessionKey;
  const memory = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  if (memory) {
    return withSessionActorStorage(
      scope,
      {
        lifetime: { assertCurrent() {}, assertReadable() {} },
        authority: memory.authority,
      },
      async (binding) => {
        const snapshot = await binding.actor.storage!.read(
          {
            type: "session.pendingInput.read",
            input: {
              kind: "source",
              sessionKey: binding.actor.target.sessionKey,
              sessionId,
              idempotencyKey,
              pendingOnly,
            },
          },
          binding.authority,
        );
        if (snapshot.kind !== "source") {
          throw new Error("Submitted input returned a different operation");
        }
        const entry = binding.actor.snapshot(binding.authority)?.entry;
        const current =
          memory.binding?.actor.target.sessionKey === binding.actor.target.sessionKey
            ? memory.binding.actor.snapshot(memory.authority)
            : memory.owner?.readSession(binding.actor.target.sessionKey, memory.authority);
        if (
          snapshot.current &&
          (!current?.entry ||
            current.entry.sessionId !== entry?.sessionId ||
            current.entry.lifecycleRevision !== entry?.lifecycleRevision)
        ) {
          throw new Error("Submitted input session was closed or replaced");
        }
        return consume(snapshot);
      },
    );
  }
  return withSessionTranscriptReadSource(
    scope,
    async ({ scope: captured, resolved, owner, expectedIdentity, assertCurrent }) => {
      if (!expectedIdentity) {
        return undefined;
      }
      const snapshot = await owner.readPendingInputSource({
        input: {
          kind: "source",
          sessionKey: resolveSqliteSessionKey(sessionKey, resolved.agentId),
          sessionId,
          idempotencyKey,
          pendingOnly,
        },
        env: captured.env,
        source: {
          agentId: resolved.databaseAgentId ?? resolved.agentId,
          path: captured.storePath,
          databaseIdentity: expectedIdentity.key.slice(5),
          databaseBirthtime: expectedIdentity.birthtime,
        },
      });
      assertCurrent();
      return consume(snapshot);
    },
    undefined,
    targetDiscoveryLane,
  );
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
  options: { includeSource: true },
): Promise<
  | { message: PersistedUserTurnMessage; source: "pending" | "transcript"; messageSeq?: number }
  | undefined
>;
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): Promise<PersistedUserTurnMessage | undefined>;
export async function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
  options?: { includeSource: true },
) {
  return readPendingInputSource(scope, idempotencyKey, false, (snapshot) => {
    if (!snapshot.current) {
      return undefined;
    }
    const { pending, committed, committedMessageSeq } = snapshot;
    const message = pending ? parseSessionPendingInputMessage(pending.message_json) : committed;
    if (!message || readMessageIdempotencyKey(message) !== idempotencyKey) {
      return undefined;
    }
    return options?.includeSource
      ? {
          message,
          source: pending ? ("pending" as const) : ("transcript" as const),
          ...(committedMessageSeq !== undefined ? { messageSeq: committedMessageSeq } : {}),
        }
      : message;
  });
}

import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { prepareSqliteScope, resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import type { PendingInputSourceRead } from "./session-pending-input-operations.types.js";
import type { PendingInputScope } from "./session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

async function readPendingInputSource(
  scope: PendingInputScope,
  idempotencyKey: string,
  pendingOnly: boolean,
) {
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
              sessionId: scope.sessionId,
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
        return {
          path: binding.path,
          snapshot,
          assertCurrent() {
            const current =
              memory.binding?.actor.target.sessionKey === binding.actor.target.sessionKey
                ? memory.binding.actor.snapshot(memory.authority)
                : memory.owner?.readSession(binding.actor.target.sessionKey, memory.authority);
            if (
              !current?.entry ||
              current.entry.sessionId !== entry?.sessionId ||
              current.entry.lifecycleRevision !== entry?.lifecycleRevision
            ) {
              throw new Error("Submitted input session was closed or replaced");
            }
          },
        };
      },
    );
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const logical = resolveSqliteScope({ ...captured, storePath: undefined });
  const input: PendingInputSourceRead = {
    kind: "source",
    sessionKey: logical.sessionKey,
    sessionId: captured.sessionId,
    idempotencyKey,
    pendingOnly,
  };
  const target = captureSessionStoreReadTarget(
    captured,
    "Submitted input changed its captured database owner",
  );
  const resolved = await prepareSqliteScope(captured);
  const { options, identity, source, assertCurrent } = target.resolve(resolved);
  if (!identity.key.startsWith("file:")) {
    return undefined;
  }
  assertCurrent();
  const snapshot = await withSessionHistoryWorkerDatabase(
    options,
    (owner) =>
      owner.readPendingInputSource({
        input: { ...input, sessionKey: resolved.sessionKey },
        env: captured.env,
        source,
      }),
    targetDiscoveryLane,
  );
  assertCurrent();
  return { path: identity.canonicalPath, snapshot, assertCurrent };
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
  const source = await readPendingInputSource(scope, idempotencyKey, false);
  if (!source?.snapshot.current) {
    return undefined;
  }
  source.assertCurrent();
  const { pending, committed, committedMessageSeq } = source.snapshot;
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
}

import { prepareSqliteScope, resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { PendingInputSourceRead } from "./session-pending-input-operations.types.js";
import type { PendingInputScope } from "./session-pending-input-store.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export async function readPendingInputSource(
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
  const snapshot = await withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readPendingInputSource({
      input: { ...input, sessionKey: resolved.sessionKey },
      env: captured.env,
      source,
    }),
  );
  assertCurrent();
  return { path: identity.canonicalPath, snapshot, assertCurrent };
}

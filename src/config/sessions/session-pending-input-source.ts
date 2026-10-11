import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { PendingInputSourceRead } from "./session-pending-input-operations.types.js";
import type { PendingInputScope } from "./session-pending-input-store.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
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
  const storePath =
    logical.path ??
    captured.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const resolved = await prepareSqliteScope(captured);
  const options = toDatabaseOptions(resolved);
  const path = resolveOpenClawAgentSqlitePath(options);
  const identity = identities.get(assertSessionStoreReadCandidate(path, candidates));
  if (!identity) {
    throw new Error("Submitted input changed its captured database owner");
  }
  if (!identity.key.startsWith("file:")) {
    return undefined;
  }
  const assertCurrent = () => {
    assertSessionStoreReadCandidate(path, candidates);
    assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
  };
  assertCurrent();
  const snapshot = await withSessionHistoryWorkerDatabase({ ...options, path }, (owner) =>
    owner.readPendingInputSource({
      input: { ...input, sessionKey: resolved.sessionKey },
      env: captured.env,
      source: {
        agentId: options.agentId,
        path,
        databaseIdentity: identity.key.slice(5),
        databaseBirthtime: identity.birthtime,
      },
    }),
  );
  assertCurrent();
  return { path: identity.canonicalPath, snapshot, assertCurrent };
}

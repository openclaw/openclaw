import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
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
  const memory = getSessionActorStorageBinding(scope);
  if (memory) {
    const snapshot = await memory.actor.storage!.read(
      {
        type: "session.pendingInput.read",
        input: {
          kind: "source",
          sessionKey: memory.actor.target.sessionKey,
          sessionId: scope.sessionId,
          idempotencyKey,
          pendingOnly,
        },
      },
      memory.authority,
    );
    if (snapshot.kind !== "source") {
      throw new Error("Submitted input returned a different operation");
    }
    return {
      path: memory.path,
      snapshot,
      assertCurrent() {
        memory.actor.assertReadable();
        memory.authority.assertCurrent();
      },
    };
  }
  const captured = {
    ...scope,
    incognito: scope.incognito ?? captureIncognitoSessionOperation(scope),
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
  if (captured.incognito) {
    const { actor, authority } = captured.incognito;
    actor.assertCurrent();
    authority.assertCurrent();
    if (
      !isIncognitoSessionKey(logical.sessionKey) ||
      actor.agentId !== logical.agentId ||
      actor.path !== resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical))
    ) {
      throw new Error("Submitted input target differs from its captured incognito actor");
    }
    const claim = actor.sessions.captureCurrent(logical.sessionKey);
    const assertCurrent = () => {
      actor.assertCurrent();
      actor.assertReadable();
      authority.assertCurrent();
      claim.assertCurrent();
    };
    const snapshot = await actor.sessions.readPendingInput(
      {
        assertCurrent,
        authorize: (stage, facts) => authority.authorize?.(stage, facts),
      },
      input,
    );
    assertCurrent();
    if (snapshot.kind !== "source") {
      throw new Error("Submitted input returned a different operation");
    }
    return { path: actor.path, snapshot, assertCurrent };
  }
  if (isIncognitoSessionKey(captured.sessionKey)) {
    // Process-held incognito storage retains its native owner until the actor cutover.
    const options = toDatabaseOptions(resolveSqliteScope(captured));
    const database = getOpenClawAgentDatabaseIfOpen(options);
    if (!database) {
      return undefined;
    }
    const assertCurrent = () => {
      if (getOpenClawAgentDatabaseIfOpen(options) !== database || !database.db.isOpen) {
        throw new Error("Submitted input lost its incognito database owner");
      }
    };
    const { readPendingInputSourceInDatabase } =
      await import("./session-pending-input-source.kernel.js");
    assertCurrent();
    return {
      path: database.path,
      snapshot: readPendingInputSourceInDatabase(database, input),
      assertCurrent,
    };
  }
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

import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { PendingInputSourceRead } from "./session-pending-input-operations.types.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export async function readPendingInputSource(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  idempotencyKey: string,
  pendingOnly: boolean,
) {
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

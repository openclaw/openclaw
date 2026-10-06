import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readIncognitoSessionEntryCurrent } from "./session-accessor.sqlite-incognito-sharing.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";
import type { SessionEntryReadWorkerOwner } from "./session-entry-read-runtime.js";
import {
  captureIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "./session-incognito-binding.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

function captureIncognitoSessionEntryCurrentRead(
  binding: IncognitoSessionBinding,
  sessionKey: string,
): Exclude<CapturedSessionEntryCurrentRead, { kind: "file" }> {
  const { actor, admissionSignal } = binding;
  const claim = actor.sessions.captureCurrent(sessionKey);
  const assertSourceCurrent = () => {
    admissionSignal?.throwIfAborted();
    actor.assertReadable();
    claim.assertCurrent();
  };
  return {
    kind: "incognito",
    assertSourceCurrent,
    readCurrent() {
      assertSourceCurrent();
      return actor.sessions.readSharing(sessionKey)?.entry;
    },
  };
}

/** Process-held currency consumes its original writer's published facts, never a native query. */
export function captureNativeSessionEntryCurrentRead(
  scope: SessionEntryReadScope,
): Exclude<CapturedSessionEntryCurrentRead, { kind: "file" }> {
  const sessionKey = scope.sessionKey;
  const agentId = scope.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  assertCanonicalSessionKeyWrite(sessionKey, agentId);
  if (!agentId) {
    throw new Error("Session currency requires its original agent");
  }
  const binding = captureIncognitoSessionBinding(scope);
  if (binding) {
    return captureIncognitoSessionEntryCurrentRead(binding, sessionKey);
  }
  const env = captureSessionTranscriptStorageEnvironment(scope.env ?? process.env);
  const storePath = isIncognitoSessionKey(sessionKey)
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
    : scope.storePath;
  if (!storePath) {
    throw new Error("Session currency requires its original incognito store");
  }
  const database = getOpenIncognitoAgentDatabase(agentId, storePath);
  const assertSourceCurrent = () => {
    if (getOpenIncognitoAgentDatabase(agentId, storePath) !== database) {
      throw new Error("Session currency incognito owner changed");
    }
  };
  return {
    kind: database ? "native" : "missing",
    assertSourceCurrent,
    readCurrent() {
      assertSourceCurrent();
      return database ? readIncognitoSessionEntryCurrent(database.db, sessionKey) : undefined;
    },
  };
}

/** Capture during the initial admitted read; later checks acquire only finite worker custody. */
export function captureSessionEntryCurrentRead(
  scope: SessionEntryReadScope,
  owner: SessionEntryReadWorkerOwner,
): CapturedSessionEntryCurrentRead {
  owner.assertCurrent();
  const sessionKey = scope.sessionKey;
  const agentId = scope.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  assertCanonicalSessionKeyWrite(sessionKey, agentId);
  if (owner.incognito) {
    return captureIncognitoSessionEntryCurrentRead(owner.incognito, sessionKey);
  }
  if (owner.kind === "native") {
    return captureNativeSessionEntryCurrentRead(scope);
  }
  if (owner.kind !== "file" || !owner.scope || !owner.selectedStore) {
    throw new Error("Session currency source is unavailable");
  }
  const readScope = {
    ...owner.scope,
    env: captureSessionTranscriptStorageEnvironment(owner.scope.env),
  };
  const candidate = { ...owner.selectedStore };
  if (candidate.physicalPath !== readScope.storePath) {
    throw new Error("Session currency selected store differs from its admitted source");
  }
  const identity = readDatabasePathIdentitySync(readScope.storePath);
  owner.assertCurrent();
  const assertLogicalSourceCurrent = () => {
    if (captureSessionStoreReadCandidate(candidate.path).physicalPath !== candidate.physicalPath) {
      throw new Error("Session currency logical source changed");
    }
  };
  assertLogicalSourceCurrent();
  if (!identity.key.startsWith("file:")) {
    const assertSourceCurrent = () => {
      const current = readDatabasePathIdentitySync(readScope.storePath);
      if (current.key !== identity.key || current.canonicalPath !== identity.canonicalPath) {
        throw new Error("Session currency missing source changed");
      }
      assertLogicalSourceCurrent();
    };
    return {
      kind: "missing",
      assertSourceCurrent,
      readCurrent() {
        assertSourceCurrent();
        return undefined;
      },
    };
  }
  const source: SessionEntryCurrentSource = Object.freeze({
    agentId: readScope.databaseAgentId,
    path: readScope.storePath,
    databaseIdentity: identity.key.slice("file:".length),
    databaseBirthtime: identity.birthtime,
    sessionKey,
  });
  const assertSourceCurrent = () => {
    assertExistingDatabaseIdentity(source.path, identity.key, identity.birthtime);
    assertLogicalSourceCurrent();
  };
  const options = { agentId: source.agentId, path: source.path, env: readScope.env };
  return {
    kind: "file",
    source,
    assertSourceCurrent,
    async readCurrent() {
      const entry = await withSessionHistoryWorkerDatabase(options, (reader) =>
        reader.readEntryCurrent({ scope: readScope, source }),
      );
      assertSourceCurrent();
      return entry;
    },
  };
}

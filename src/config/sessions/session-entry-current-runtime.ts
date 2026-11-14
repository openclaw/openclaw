import { parseAgentSessionKey } from "../../routing/session-key.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-row.js";
import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";
import { captureSessionExecutionPolicy } from "./session-entry-execution-policy.js";
import type { SessionEntryReadWorkerOwner } from "./session-entry-read-runtime.js";
import { prepareSessionStoreCandidatesInWorker } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Read live effect facts from the memory owner selected at acquisition. */
export function captureNativeSessionEntryCurrentRead(
  scope: SessionEntryReadScope,
): Exclude<CapturedSessionEntryCurrentRead, { kind: "file" }> {
  const memory = captureMemoryExactSessionReader(scope);
  if (!memory) {
    throw new Error("Session current facts require a memory owner");
  }
  return {
    kind: memory.source ? "incognito" : "missing",
    assertSourceCurrent: () => memory.assertCurrent(),
    readCurrent() {
      const entry = memory.read(scope.sessionKey, "list");
      return entry
        ? { ...entry, executionPolicy: captureSessionExecutionPolicy(entry) }
        : undefined;
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
  if (owner.kind === "incognito") {
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
  const captured = owner.source;
  if (!captured) {
    throw new Error("Session currency source is unavailable");
  }
  // Retain an observed refusal until a fresh worker read qualifies this captured source again.
  let sourceChanged = false;
  const assertLogicalSourceCurrent = () => {
    if (sourceChanged) {
      throw new Error("Session currency logical source changed");
    }
  };
  const source: SessionEntryCurrentSource = Object.freeze({
    agentId: readScope.databaseAgentId,
    path: readScope.storePath,
    databaseIdentity: captured.databaseIdentity,
    databaseBirthtime: captured.databaseBirthtime,
    readCustody: owner.readCustody,
    sessionKey,
  });
  const options = {
    agentId: source.agentId,
    path: source.path,
    env: readScope.env,
    readCustody: source.readCustody && [source.readCustody],
  };
  return {
    kind: "file",
    source,
    assertSourceCurrent: assertLogicalSourceCurrent,
    async readCurrent() {
      try {
        const entry = await withSessionHistoryWorkerDatabase(options, (reader) =>
          reader.readEntryCurrent({ scope: readScope, source }),
        );
        if (source.readCustody) {
          await prepareSessionStoreCandidatesInWorker({
            validate: { readCustody: [source.readCustody], candidates: [], sources: [] },
          });
        }
        sourceChanged = false;
        return entry;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("outside captured discovery custody")
        ) {
          sourceChanged = true;
          assertLogicalSourceCurrent();
        }
        throw error;
      }
    },
  };
}

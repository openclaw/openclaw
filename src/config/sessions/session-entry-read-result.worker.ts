import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { readExactSessionEntryFactsInDatabase } from "./session-accessor.sqlite-entry-facts.worker.js";
import { loadSessionEntryReadOnlyResultInScope } from "./session-accessor.sqlite-exact-read.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionEntryReadWorkerInput,
  SessionEntryReadWorkerResult,
} from "./session-entry-read.types.js";
import { encodeSessionTranscriptWorkerError } from "./session-history-worker-errors.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

/** Native writer operations must finish their captured-database reads synchronously. */
export function readSessionEntryResult(
  request: SessionEntryReadWorkerInput,
  capturedDatabase?: OpenClawAgentReadOnlyDatabase,
): SessionEntryReadWorkerResult {
  let source: SessionEntryReadWorkerResult["source"];
  let facts: SessionEntryReadWorkerResult["facts"];
  const read = loadSessionEntryReadOnlyResultInScope(
    {
      ...request.scope,
      env: cloneEnvWithPlatformSemantics(request.scope.env ?? process.env),
    },
    request.continuation,
    (readSource) => {
      if (typeof readSource.databaseIdentity !== "string") {
        throw new Error("Private session entry requires its process-held owner");
      }
      source = { ...readSource, databaseIdentity: readSource.databaseIdentity };
    },
    (database, sessionKey, projection) => {
      const selected = readExactSessionEntryFactsInDatabase(
        database,
        collectSessionEntryLookupKeys(sessionKey),
        projection,
      );
      const captured = captureSessionEntryReadSource(database, undefined);
      facts = {
        kind: "session-exact-entries",
        ...selected,
        source: captured,
        databaseIdentity: {
          ...readOpenClawAgentDatabaseIdentity(database),
          identity: captured.databaseIdentity,
        },
        lifecycleTimestamps: {},
      };
      return selected.entries.find((row) => row.sessionKey === sessionKey.trim())?.entry;
    },
    capturedDatabase,
  );
  if (!read.ok) {
    const readError = encodeSessionTranscriptWorkerError(read.error);
    if (!readError || readError.kind === "fence") {
      throw read.error;
    }
    return { kind: "session-entry-read", entry: undefined, source, readError };
  }
  return { kind: "session-entry-read", entry: read.value, source, facts };
}

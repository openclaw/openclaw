import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "./session-transcript-projection-error.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

export function withCurrentProjectionSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (projection: CurrentTranscriptProjection) => T,
  options: { readOnly?: boolean; resolvedScope?: ResolvedTranscriptReadScope } = {},
): T {
  const resolved = options.resolvedScope ?? resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const readSnapshot = (database: CurrentTranscriptProjection["database"]) =>
    readCurrentProjectionSnapshot(database, resolved, read);
  const result = options.readOnly
    ? withOpenClawAgentDatabaseReadOnly(readSnapshot, databaseOptions)
    : { found: true as const, value: readSnapshot(openOpenClawAgentDatabase(databaseOptions)) };
  if (!result.found) {
    throw new SessionTranscriptStorageUnavailableError(result.reason);
  }
  if (result.value.kind === "value") {
    return result.value.value;
  }
  // Only the writer lifecycle may rebuild after this stack unwinds. Read-only catalogs
  // report unavailable and leave reconciliation to the source Gateway.
  if (!options.readOnly) {
    startSessionTranscriptIndexReconcile({
      ...databaseOptions,
      preferredSessionId: resolved.sessionId,
    });
  }
  throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
}

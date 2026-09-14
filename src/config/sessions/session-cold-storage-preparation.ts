import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  readOpenClawAgentDatabaseRegistrySnapshot,
  type OpenClawAgentDatabaseRegistrySnapshot,
} from "../../state/openclaw-agent-db-registry-listing.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  readSessionColdTranscript,
  type SessionColdArchive,
} from "./session-cold-storage-state.js";

export type SessionColdPreparationRequest =
  | {
      scope: SessionTranscriptReadScope;
      registeredDatabases?: readonly OpenClawRegisteredAgentDatabase[];
    }
  | { target: ResolvedTranscriptReadScope };
export type SessionColdPreparationResult = {
  target: ResolvedTranscriptReadScope & { path: string };
  archive: Omit<SessionColdArchive, "archive_blob"> | undefined;
  registeredDatabases?: OpenClawRegisteredAgentDatabase[];
};

export type SessionColdReadTarget = ResolvedTranscriptReadScope & {
  path: string;
  registrySnapshot?: OpenClawAgentDatabaseRegistrySnapshot;
};

export type SessionColdReadPreparation = (
  request: Extract<SessionColdPreparationRequest, { scope: SessionTranscriptReadScope }>,
  registryGeneration?: symbol,
) => Promise<SessionColdPreparationResult>;

/** One fresh metadata read, without opening a writable owner or reading the archive payload. */
export function prepareSessionColdTranscriptRead(
  request: SessionColdPreparationRequest,
): SessionColdPreparationResult {
  const freshRegistry =
    "scope" in request && request.registeredDatabases === undefined
      ? readOpenClawAgentDatabaseRegistrySnapshot({ env: request.scope.env })
      : undefined;
  const resolved =
    "target" in request
      ? request.target
      : resolveSqliteTranscriptReadScope(
          request.scope,
          undefined,
          (request.registeredDatabases ?? freshRegistry)?.filter(
            (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
          ),
        );
  const options = toDatabaseOptions(resolved);
  const target = { ...resolved, path: resolveOpenClawAgentSqlitePath(options) };
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdTranscript(database.db, resolved.sessionId),
    options,
  );
  return {
    target,
    archive: read.found ? read.value : undefined,
    ...(freshRegistry ? { registeredDatabases: freshRegistry } : {}),
  };
}

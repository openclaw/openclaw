// Stats-only readers must not load transcript writers or actor acquisition.
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptStats,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-read-scope.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope-helpers.js";
import { readTranscriptStatsBatchFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";

/** Read transcript stats in database groups without joining the writable lifecycle. */
export function readTranscriptStatsBatchReadOnlySync(
  scopes: readonly SessionTranscriptReadScope[],
): Array<SessionTranscriptStats | null> {
  const results = scopes.map((): SessionTranscriptStats | null => null);
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  const groups = new Map<
    string,
    {
      options: ReturnType<typeof toDatabaseOptions>;
      items: Array<{ index: number; sessionId: string }>;
    }
  >();
  for (const [index, scope] of scopes.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(scope, targetCache);
    const options = toDatabaseOptions(resolved);
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const key = `${options.agentId}\0${pathname}`;
    const group = groups.get(key) ?? { options, items: [] };
    group.items.push({ index, sessionId: resolved.sessionId });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    try {
      const read = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          readTranscriptStatsBatchFromDatabase(
            database,
            group.items.map((item) => item.sessionId),
          ),
        group.options,
      );
      if (read.found) {
        for (const [index, item] of group.items.entries()) {
          results[item.index] = read.value[index]!;
        }
      }
    } catch (error) {
      if (!(error instanceof SessionMetadataUnavailableError)) {
        throw error;
      }
      // A missing table leaves the whole store unavailable, including earlier chunks.
    }
  }
  return results;
}

import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptExportStatsFromDatabase,
  readTranscriptStatsFromDatabase,
} from "./session-accessor.sqlite-transcript-stats.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type TranscriptExportOptions = {
  projection?: "reset-boundary";
  /** Reduce each decoded event synchronously before retaining the snapshot. */
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  /** Worker-owned projection from the preceding export; null starts an incremental reader. */
  previous?: {
    events: TranscriptEvent[];
    generation: string | null;
    throughSeq: number;
  } | null;
};

/** Fence, statistics, session key and incremental-export decision for one export snapshot. */
export function readTranscriptExportHead(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ResolvedTranscriptReadScope,
  options: TranscriptExportOptions,
) {
  const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
  const { stats, generation, cold } =
    options.previous !== undefined
      ? readTranscriptExportStatsFromDatabase(database, resolved.sessionId)
      : {
          stats: readTranscriptStatsFromDatabase(database, resolved.sessionId),
          generation: null,
          cold: false,
        };
  // Cached rows must still enter the existing archive restoration path.
  if (cold) {
    throw new SessionTranscriptColdError(resolved.sessionId);
  }
  const throughSeq = Math.min(
    stats.eventCount === 0 ? -1 : stats.maxSeq,
    fence ? fence.beforeRawSeq - 1 : Number.POSITIVE_INFINITY,
  );
  const previous =
    generation !== null &&
    options.previous?.generation === generation &&
    options.previous.throughSeq <= throughSeq
      ? options.previous
      : undefined;
  const sessionKey =
    resolved.sessionKey ??
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_windows")
        .select("session_key")
        .where("session_id", "=", resolved.sessionId)
        .limit(1),
    )?.session_key;
  return {
    beforeEventSeq: fence?.beforeRawSeq,
    afterEventSeq: previous?.throughSeq,
    skipEvents: previous?.throughSeq === throughSeq,
    previousEvents: previous?.events ?? [],
    stats,
    sessionKey,
    incremental: options.previous !== undefined ? { generation, throughSeq } : {},
  };
}

/** The export snapshot shape callers retain: earlier projected events first, then the new ones. */
export function toTranscriptExportSnapshot({
  events,
  previousEvents,
  stats,
  sessionKey,
  incremental,
}: ReturnType<typeof readTranscriptExportHead> & { events: TranscriptEvent[] }) {
  return { events: [...previousEvents, ...events], stats, sessionKey, ...incremental };
}

// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and the lazy reconcile that backfills
// doctor-migrated transcripts and rebuilds branch-rewound sessions.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveStateDir } from "../paths.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";

const log = createSubsystemLogger("sessions/search-index");
const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;
const RECONCILE_WORKER_TIMEOUT_MS = 60_000;
const RECONCILE_PLANNING_TIMEOUT_MS = 30 * 60_000;

type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "assistant" | "user";
  timestamp: number;
  snippet: string;
  score: number;
};

type SessionTranscriptSearchResult = {
  hits: SessionTranscriptSearchHit[];
  indexing: boolean;
  truncated: boolean;
};

const runningReconciles = new Map<string, Promise<void>>();
const activeReconciles = new Map<string, Promise<void>>();
let reconcileQueue = Promise.resolve();

/**
 * Starts one worker-owned reconcile per agent. The worker plans outside
 * transactions and commits bounded batches so Gateway-thread SQLite writers
 * never wait behind a whole transcript rebuild.
 */
function resolveReconcileWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distIndex = normalized.lastIndexOf("/dist/");
  if (distIndex >= 0) {
    return pathToFileURL(
      path.join(
        currentPath.slice(0, distIndex + 6),
        "config",
        "sessions",
        "session-transcript-reconcile.worker.js",
      ),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./session-transcript-reconcile.worker${extension}`, currentModuleUrl);
}

function reconcileKey(params: { agentId: string; env?: NodeJS.ProcessEnv }): string {
  return `${resolveStateDir(params.env)}\0${params.agentId}`;
}

function runReconcileWorker(params: {
  agentId: string;
  stateDir: string;
  workerUrl?: URL;
  timeoutMs?: number;
  planningTimeoutMs?: number;
  onStarted?: () => void;
}): Promise<void> {
  const workerUrl = params.workerUrl ?? resolveReconcileWorkerUrl();
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: { agentId: params.agentId, stateDir: params.stateDir },
      execArgv: workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined,
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  worker.unref?.();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const scheduleTimeout = (timeoutMs: number) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        finish(() => reject(new Error("session transcript reconcile worker timed out")), true);
      }, timeoutMs);
    };
    const finish = (done: () => void, terminate: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      if (terminate) {
        void worker.terminate();
      }
      done();
    };
    worker.on("message", (message: { status?: unknown; error?: unknown }) => {
      if (message.status === "ready") {
        // Planning is read-only and can be large, so it gets a generous
        // watchdog distinct from bounded-write inactivity.
        scheduleTimeout(
          resolveTimerTimeoutMs(params.planningTimeoutMs, RECONCILE_PLANNING_TIMEOUT_MS),
        );
        return;
      }
      if (message.status === "started") {
        scheduleTimeout(resolveTimerTimeoutMs(params.timeoutMs, RECONCILE_WORKER_TIMEOUT_MS));
        params.onStarted?.();
        return;
      }
      if (message.status === "progress") {
        scheduleTimeout(resolveTimerTimeoutMs(params.timeoutMs, RECONCILE_WORKER_TIMEOUT_MS));
        return;
      }
      finish(
        () =>
          message.status === "ok"
            ? resolve()
            : reject(
                new Error(
                  typeof message.error === "string"
                    ? message.error
                    : "session transcript reconcile worker failed",
                ),
              ),
        false,
      );
    });
    worker.once("error", (error) =>
      finish(
        () =>
          reject(
            error instanceof Error
              ? new Error(error.message, { cause: error })
              : new Error(String(error)),
          ),
        true,
      ),
    );
    worker.once("exit", (code) =>
      finish(
        () =>
          reject(
            new Error(
              `session transcript reconcile worker exited before completing (code ${code})`,
            ),
          ),
        false,
      ),
    );
    scheduleTimeout(resolveTimerTimeoutMs(params.timeoutMs, RECONCILE_WORKER_TIMEOUT_MS));
  });
}

function startReconcile(params: { agentId: string; env?: NodeJS.ProcessEnv }): void {
  const key = reconcileKey(params);
  if (runningReconciles.has(key)) {
    return;
  }
  let markStarted!: () => void;
  activeReconciles.set(
    key,
    new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
  );
  // Reconcile is cache maintenance, not request work. One process-wide slot
  // bounds worker/SQLite pressure while the DB claim protects other processes.
  const pending = reconcileQueue
    .then(() =>
      runReconcileWorker({
        agentId: params.agentId,
        stateDir: resolveStateDir(params.env),
        onStarted: markStarted,
      }),
    )
    .catch((error: unknown) => {
      // Leave the dirty marker intact. A later search retries without ever
      // falling back to a Gateway-thread rebuild.
      log.warn(
        `session transcript reconcile failed agent=${params.agentId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      markStarted();
      runningReconciles.delete(key);
      activeReconciles.delete(key);
    });
  runningReconciles.set(key, pending);
  reconcileQueue = pending;
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

/** Search the per-agent FTS index; kicks off one background reconcile when the index lags. */
export function searchSessionTranscripts(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  sessionKeys?: string[];
}): SessionTranscriptSearchResult {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const dirtySessions = listSessionsNeedingTranscriptIndexReconcile(database.db);
  if (dirtySessions.length > 0) {
    startReconcile(params);
  }
  const indexing = dirtySessions.length > 0 || runningReconciles.has(reconcileKey(params));
  const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
  const sessionKeys = params.sessionKeys ?? [];
  const whereSession =
    sessionKeys.length > 0
      ? ` AND sessions.session_key IN (${sessionKeys.map(() => "?").join(", ")})`
      : "";
  // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
  // representation. session_key lives on the sessions row so key renames
  // never leave stale keys inside the index. Sessions flagged needs_rebuild
  // are excluded: their rows may still hold rewound-away branch text that
  // sessions_history no longer exposes, so they stay hidden until reconcile
  // rebuilds them (indexing=true tells the caller to retry).
  const statement = database.db.prepare(/* sqlite-allow-raw: FTS5 MATCH/snippet/bm25 */ `
    SELECT sessions.session_key AS session_key, session_transcript_fts.session_id AS session_id,
      message_id, role, timestamp,
      snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
      bm25(session_transcript_fts) AS rank
    FROM session_transcript_fts
    JOIN sessions ON sessions.session_id = session_transcript_fts.session_id
    WHERE session_transcript_fts MATCH ?${whereSession}
      AND session_transcript_fts.session_id NOT IN (
        SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
      )
    ORDER BY rank ASC, timestamp DESC, message_id ASC
    LIMIT ?
  `);
  const values = [toFtsQuery(query), ...sessionKeys, limit + 1];
  const rows = statement.all(...values) as Array<{
    message_id: unknown;
    rank: unknown;
    role: unknown;
    session_id: unknown;
    session_key: unknown;
    snippet: unknown;
    timestamp: unknown;
  }>;
  const hits = rows.flatMap((row): SessionTranscriptSearchHit[] => {
    if (
      typeof row.session_key !== "string" ||
      typeof row.session_id !== "string" ||
      typeof row.message_id !== "string" ||
      (row.role !== "user" && row.role !== "assistant") ||
      typeof row.snippet !== "string"
    ) {
      return [];
    }
    const timestamp = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
    const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
    return [
      {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        snippet:
          row.snippet.length > SEARCH_SNIPPET_MAX_CHARS
            ? `${truncateUtf16Safe(row.snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
            : row.snippet,
        score: Number.isFinite(rank) ? -rank : 0,
      },
    ];
  });
  return { hits: hits.slice(0, limit), indexing, truncated: hits.length > limit };
}

/** Await active reconcile passes in focused tests. */
export async function waitForSessionTranscriptReconcileForTest(): Promise<void> {
  await Promise.all(runningReconciles.values());
}

/** Await worker startup in focused responsiveness tests. */
export async function waitForSessionTranscriptReconcileActiveForTest(): Promise<void> {
  await Promise.all(activeReconciles.values());
}

/** Reset process-local reconcile state between focused tests. */
export function resetSessionTranscriptSearchForTest(): void {
  runningReconciles.clear();
  activeReconciles.clear();
  reconcileQueue = Promise.resolve();
}

/** Test-only worker lifecycle and packaging seams. */
export const sessionTranscriptSearchTesting = {
  reconcileWorkerTimeoutMs: RECONCILE_WORKER_TIMEOUT_MS,
  reconcilePlanningTimeoutMs: RECONCILE_PLANNING_TIMEOUT_MS,
  resolveReconcileWorkerUrl,
  runReconcileWorker,
};

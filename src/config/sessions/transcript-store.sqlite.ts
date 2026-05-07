import fs from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "../../infra/json-files.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

export type SqliteSessionTranscriptEvent = {
  seq: number;
  event: unknown;
  createdAt: number;
};

export type SqliteSessionTranscriptStoreOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  sessionId: string;
};

export type AppendSqliteSessionTranscriptEventOptions = SqliteSessionTranscriptStoreOptions & {
  event: unknown;
  transcriptPath?: string;
  now?: () => number;
};

export type ReplaceSqliteSessionTranscriptEventsOptions = SqliteSessionTranscriptStoreOptions & {
  events: unknown[];
  transcriptPath?: string;
  now?: () => number;
};

export type ImportJsonlTranscriptToSqliteOptions = SqliteSessionTranscriptStoreOptions & {
  transcriptPath: string;
  now?: () => number;
};

export type ExportSqliteTranscriptJsonlOptions = SqliteSessionTranscriptStoreOptions;

export type SqliteSessionTranscriptScope = {
  agentId: string;
  sessionId: string;
};

export type SqliteSessionTranscriptFile = SqliteSessionTranscriptScope & {
  path: string;
  updatedAt: number;
};

function normalizeSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId) {
    throw new Error("SQLite transcript store requires a session id.");
  }
  return sessionId;
}

function normalizeTranscriptScope(options: SqliteSessionTranscriptStoreOptions): {
  agentId: string;
  sessionId: string;
} {
  return {
    agentId: normalizeAgentId(options.agentId),
    sessionId: normalizeSessionId(options.sessionId),
  };
}

function parseTranscriptEventJson(value: unknown, seq: number): unknown {
  if (typeof value !== "string") {
    throw new Error(`SQLite transcript event ${seq} is not stored as JSON.`);
  }
  return JSON.parse(value);
}

function parseCreatedAt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function rememberTranscriptFile(params: {
  agentId: string;
  sessionId: string;
  transcriptPath?: string;
  importedAt?: number;
  exportedAt?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  const transcriptPath = params.transcriptPath?.trim();
  if (!transcriptPath) {
    return;
  }
  const resolvedTranscriptPath = path.resolve(transcriptPath);
  runOpenClawStateWriteTransaction((database) => {
    database.db
      .prepare(
        `
          INSERT INTO transcript_files (
            agent_id,
            session_id,
            path,
            imported_at,
            exported_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, session_id, path) DO UPDATE SET
            imported_at = COALESCE(excluded.imported_at, transcript_files.imported_at),
            exported_at = COALESCE(excluded.exported_at, transcript_files.exported_at)
        `,
      )
      .run(
        params.agentId,
        params.sessionId,
        resolvedTranscriptPath,
        params.importedAt ?? null,
        params.exportedAt ?? null,
      );
  }, params.options);
}

export function resolveSqliteSessionTranscriptScopeForPath(
  options: OpenClawStateDatabaseOptions & { transcriptPath: string },
): SqliteSessionTranscriptScope | undefined {
  const transcriptPath = path.resolve(options.transcriptPath);
  const database = openOpenClawStateDatabase(options);
  const row = database.db
    .prepare(
      `
        SELECT agent_id, session_id
        FROM transcript_files
        WHERE path = ?
        ORDER BY COALESCE(imported_at, exported_at, 0) DESC
        LIMIT 1
      `,
    )
    .get(transcriptPath) as { agent_id?: unknown; session_id?: unknown } | undefined;
  if (typeof row?.agent_id !== "string" || typeof row.session_id !== "string") {
    return undefined;
  }
  return {
    agentId: normalizeAgentId(row.agent_id),
    sessionId: normalizeSessionId(row.session_id),
  };
}

export function listSqliteSessionTranscriptFiles(
  options: OpenClawStateDatabaseOptions = {},
): SqliteSessionTranscriptFile[] {
  const database = openOpenClawStateDatabase(options);
  return database.db
    .prepare(
      `
        SELECT
          files.agent_id,
          files.session_id,
          files.path,
          MAX(
            COALESCE(events.created_at, 0),
            COALESCE(files.imported_at, 0),
            COALESCE(files.exported_at, 0)
          ) AS updated_at
        FROM transcript_files files
        LEFT JOIN transcript_events events
          ON events.agent_id = files.agent_id
          AND events.session_id = files.session_id
        GROUP BY files.agent_id, files.session_id, files.path
        ORDER BY updated_at DESC, files.path ASC
      `,
    )
    .all()
    .flatMap((row) => {
      const record = row as {
        agent_id?: unknown;
        session_id?: unknown;
        path?: unknown;
        updated_at?: unknown;
      };
      if (
        typeof record.agent_id !== "string" ||
        typeof record.session_id !== "string" ||
        typeof record.path !== "string"
      ) {
        return [];
      }
      const updatedAt =
        typeof record.updated_at === "bigint"
          ? Number(record.updated_at)
          : Number(record.updated_at ?? 0);
      return [
        {
          agentId: normalizeAgentId(record.agent_id),
          sessionId: normalizeSessionId(record.session_id),
          path: record.path,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        },
      ];
    });
}

export function appendSqliteSessionTranscriptEvent(
  options: AppendSqliteSessionTranscriptEventOptions,
): { seq: number } {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  const seq = runOpenClawStateWriteTransaction((database) => {
    const row = database.db
      .prepare(
        `
          SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
          FROM transcript_events
          WHERE agent_id = ? AND session_id = ?
        `,
      )
      .get(agentId, sessionId) as { next_seq?: number | bigint } | undefined;
    const nextSeq = typeof row?.next_seq === "bigint" ? Number(row.next_seq) : (row?.next_seq ?? 0);
    database.db
      .prepare(
        `
          INSERT INTO transcript_events (
            agent_id,
            session_id,
            seq,
            event_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(agentId, sessionId, nextSeq, JSON.stringify(options.event), now);
    return nextSeq;
  }, options);

  rememberTranscriptFile({
    agentId,
    sessionId,
    transcriptPath: options.transcriptPath,
    importedAt: now,
    options,
  });
  return { seq };
}

export function replaceSqliteSessionTranscriptEvents(
  options: ReplaceSqliteSessionTranscriptEventsOptions,
): { replaced: number } {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const now = options.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    database.db
      .prepare("DELETE FROM transcript_events WHERE agent_id = ? AND session_id = ?")
      .run(agentId, sessionId);
    const insert = database.db.prepare(
      `
        INSERT INTO transcript_events (
          agent_id,
          session_id,
          seq,
          event_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
    );
    options.events.forEach((event, seq) => {
      insert.run(agentId, sessionId, seq, JSON.stringify(event), now);
    });
  }, options);

  rememberTranscriptFile({
    agentId,
    sessionId,
    transcriptPath: options.transcriptPath,
    importedAt: now,
    options,
  });
  return { replaced: options.events.length };
}

export function loadSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): SqliteSessionTranscriptEvent[] {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const database = openOpenClawStateDatabase(options);
  return database.db
    .prepare(
      `
        SELECT seq, event_json, created_at
        FROM transcript_events
        WHERE agent_id = ? AND session_id = ?
        ORDER BY seq ASC
      `,
    )
    .all(agentId, sessionId)
    .map((row) => {
      const record = row as { seq: number | bigint; event_json: unknown; created_at: unknown };
      const seq = typeof record.seq === "bigint" ? Number(record.seq) : record.seq;
      return {
        seq,
        event: parseTranscriptEventJson(record.event_json, seq),
        createdAt: parseCreatedAt(record.created_at),
      };
    });
}

export function hasSqliteSessionTranscriptEvents(
  options: SqliteSessionTranscriptStoreOptions,
): boolean {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const database = openOpenClawStateDatabase(options);
  const row = database.db
    .prepare(
      `
        SELECT 1 AS found
        FROM transcript_events
        WHERE agent_id = ? AND session_id = ?
        LIMIT 1
      `,
    )
    .get(agentId, sessionId) as { found?: number | bigint } | undefined;
  return row?.found !== undefined;
}

export function exportSqliteSessionTranscriptJsonl(
  options: ExportSqliteTranscriptJsonlOptions,
): string {
  const lines = loadSqliteSessionTranscriptEvents(options).map((entry) =>
    JSON.stringify(entry.event),
  );
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export async function writeSqliteSessionTranscriptJsonl(
  options: ExportSqliteTranscriptJsonlOptions & { transcriptPath: string },
): Promise<{ exported: number; transcriptPath: string }> {
  const { agentId, sessionId } = normalizeTranscriptScope(options);
  const jsonl = exportSqliteSessionTranscriptJsonl(options);
  await writeTextAtomic(options.transcriptPath, jsonl, { mode: 0o600 });
  rememberTranscriptFile({
    agentId,
    sessionId,
    transcriptPath: options.transcriptPath,
    exportedAt: Date.now(),
    options,
  });
  return {
    exported: jsonl ? jsonl.trimEnd().split(/\r?\n/).length : 0,
    transcriptPath: options.transcriptPath,
  };
}

export function importJsonlTranscriptToSqlite(options: ImportJsonlTranscriptToSqliteOptions): {
  imported: number;
  transcriptPath: string;
} {
  const raw = fs.readFileSync(options.transcriptPath, "utf-8");
  const events = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid transcript JSONL at line ${index + 1}: ${options.transcriptPath}`,
          {
            cause: error,
          },
        );
      }
    });
  replaceSqliteSessionTranscriptEvents({
    ...options,
    events,
    transcriptPath: options.transcriptPath,
  });
  return {
    imported: events.length,
    transcriptPath: options.transcriptPath,
  };
}

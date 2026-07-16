// Stores and streams transcript files for later summary and replay.
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { resolveOptionalIntegerOption } from "@openclaw/normalization-core/number-coercion";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import type { TranscriptsSummary } from "./summary.js";
import { renderTranscriptsMarkdown } from "./summary.js";

/**
 * Transcript session store backed by filesystem or shared SQLite state DB.
 *
 * When an optional `OpenClawStateDatabase` handle is supplied, the store
 * prefers SQLite for session metadata and utterances. File-based paths
 * remain available for callers that need directory access and the rendered
 * markdown summary is still written to disk as a user-visible artifact.
 */
/** Stored session metadata plus the resolved session directory. */
export type TranscriptsSessionEntry = {
  session: TranscriptSessionDescriptor;
  sessionDir: string;
};

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function dateSegment(value: string | undefined): string {
  const isoDate = value?.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  return isoDate ?? new Date().toISOString().slice(0, 10);
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function sameSessionIdentity(
  left: TranscriptSessionDescriptor,
  right: TranscriptSessionDescriptor,
): boolean {
  return left.sessionId === right.sessionId && left.startedAt === right.startedAt;
}

function toSqlValue(value: unknown): import("node:sqlite").SQLInputValue {
  return (value === undefined ? null : value) as import("node:sqlite").SQLInputValue;
}

function nowMs(): number {
  return Date.now();
}

// ── SQLite row mapping ─────────────────────────────────────────

function sessionFromRow(row: Record<string, unknown>): TranscriptSessionDescriptor {
  const sourceJson =
    typeof row.source_json === "string"
      ? (JSON.parse(row.source_json) as Record<string, unknown>)
      : undefined;
  const source = sourceJson ?? {
    providerId: row.provider_id as string,
    ...(row.account_id ? { accountId: row.account_id as string } : {}),
    ...(row.guild_id ? { guildId: row.guild_id as string } : {}),
    ...(row.channel_id ? { channelId: row.channel_id as string } : {}),
    ...(row.meeting_url ? { meetingUrl: row.meeting_url as string } : {}),
    ...(row.thread_ts ? { threadTs: row.thread_ts as string } : {}),
    ...(row.file_id ? { fileId: row.file_id as string } : {}),
  };
  return {
    sessionId: row.session_id as string,
    source: source as TranscriptSessionDescriptor["source"],
    startedAt: row.started_at as string,
    ...(row.title ? { title: row.title as string } : {}),
    ...(row.stopped_at ? { stoppedAt: row.stopped_at as string } : {}),
    ...(row.metadata_json
      ? { metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown> }
      : {}),
  };
}

function rowFromSession(session: TranscriptSessionDescriptor): Record<string, unknown> {
  const source = session.source;
  return {
    session_id: session.sessionId,
    provider_id: source.providerId,
    title: session.title ?? null,
    account_id: source.accountId ?? null,
    guild_id: source.guildId ?? null,
    channel_id: source.channelId ?? null,
    meeting_url: source.meetingUrl ?? null,
    thread_ts: source.threadTs ?? null,
    file_id: source.fileId ?? null,
    source_json: JSON.stringify(source),
    started_at: session.startedAt,
    stopped_at: session.stoppedAt ?? null,
    metadata_json: session.metadata ? JSON.stringify(session.metadata) : null,
  };
}

function utteranceFromRow(row: Record<string, unknown>): TranscriptUtterance {
  return {
    id: row.utterance_id as string | undefined,
    sessionId: row.session_id as string,
    text: row.text as string,
    startedAt: row.started_at as string | undefined,
    endedAt: row.ended_at as string | undefined,
    final: (row.final as number) === 1,
    ...(row.speaker_label
      ? {
          speaker: {
            label: row.speaker_label as string,
            ...(row.speaker_id ? { id: row.speaker_id as string } : {}),
          },
        }
      : {}),
    ...(row.metadata_json
      ? { metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown> }
      : {}),
  };
}

/** Durable transcript store rooted at a caller-provided directory. */
export class TranscriptsStore {
  private readonly stateDb: OpenClawStateDatabase | undefined;

  constructor(
    private readonly rootDir: string,
    stateDb?: OpenClawStateDatabase,
  ) {
    this.stateDb = stateDb;
  }

  private dbExec(sql: string, params: import("node:sqlite").SQLInputValue[]): unknown[] {
    if (!this.stateDb) {
      throw new Error("TranscriptsStore SQLite operations require an OpenClawStateDatabase handle");
    }
    const stmt = this.stateDb.db.prepare(sql);
    return stmt.all(...params);
  }

  private dbRun(sql: string, params: import("node:sqlite").SQLInputValue[]): void {
    if (!this.stateDb) {
      throw new Error("TranscriptsStore SQLite operations require an OpenClawStateDatabase handle");
    }
    const stmt = this.stateDb.db.prepare(sql);
    stmt.run(...params);
  }

  private dbGet(
    sql: string,
    params: import("node:sqlite").SQLInputValue[],
  ): Record<string, unknown> | undefined {
    if (!this.stateDb) {
      throw new Error("TranscriptsStore SQLite operations require an OpenClawStateDatabase handle");
    }
    const stmt = this.stateDb.db.prepare(sql);
    return stmt.get(...params) as Record<string, unknown> | undefined;
  }

  private writeSessionSql(session: TranscriptSessionDescriptor): void {
    const ts = nowMs();
    const row = rowFromSession(session);
    this.dbRun(
      `INSERT OR REPLACE INTO transcript_sessions
       (session_id, provider_id, title, account_id, guild_id, channel_id, meeting_url,
        thread_ts, file_id, source_json,
        started_at, stopped_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toSqlValue(row.session_id),
        toSqlValue(row.provider_id),
        toSqlValue(row.title),
        toSqlValue(row.account_id),
        toSqlValue(row.guild_id),
        toSqlValue(row.channel_id),
        toSqlValue(row.meeting_url),
        toSqlValue(row.thread_ts),
        toSqlValue(row.file_id),
        toSqlValue(row.source_json),
        toSqlValue(row.started_at),
        toSqlValue(row.stopped_at),
        toSqlValue(row.metadata_json),
        toSqlValue(ts),
        toSqlValue(ts),
      ],
    );
  }

  /** Resolve the dated directory for a transcript session. */
  sessionDir(session: TranscriptSessionDescriptor): string {
    return path.join(this.rootDir, dateSegment(session.startedAt), safeSegment(session.sessionId));
  }

  private async hasSessionMetadata(dir: string): Promise<boolean> {
    return (await readJsonFile<unknown>(path.join(dir, "metadata.json"))) !== undefined;
  }

  private async findSessionDirForSession(session: TranscriptSessionDescriptor): Promise<string> {
    const datedDir = this.sessionDir(session);
    const datedSession = await readJsonFile<TranscriptSessionDescriptor>(
      path.join(datedDir, "metadata.json"),
    );
    if (datedSession && sameSessionIdentity(datedSession, session)) {
      return datedDir;
    }
    return datedDir;
  }

  private async findSessionDir(selector: string): Promise<string | undefined> {
    const qualified = selector.match(/^(\d{4}-\d{2}-\d{2})\/(.+)$/);
    if (qualified?.[1] && qualified[2]) {
      const directDir = path.join(this.rootDir, qualified[1], safeSegment(qualified[2]));
      return (await this.hasSessionMetadata(directDir)) ? directDir : undefined;
    }

    const safeSessionId = safeSegment(selector);
    const idDate = selector
      .match(/^meeting-(\d{4})-(\d{2})-(\d{2})T/)
      ?.slice(1, 4)
      .join("-");
    if (idDate) {
      const directDir = path.join(this.rootDir, idDate, safeSessionId);
      return (await this.hasSessionMetadata(directDir)) ? directDir : undefined;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    const datedEntries = entries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .toSorted((left, right) => right.name.localeCompare(left.name));
    const matches: string[] = [];
    for (const entry of datedEntries) {
      const candidate = path.join(this.rootDir, entry.name, safeSessionId);
      const session = await readJsonFile<TranscriptSessionDescriptor>(
        path.join(candidate, "metadata.json"),
      );
      if (session?.sessionId === selector) {
        matches.push(candidate);
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `multiple transcripts sessions match ${selector}; use a YYYY-MM-DD/${selector} selector`,
      );
    }
    return matches[0];
  }

  /** Persist transcript session metadata. */
  async writeSession(session: TranscriptSessionDescriptor): Promise<void> {
    if (this.stateDb) {
      runOpenClawStateWriteTransaction(() => {
        this.writeSessionSql(session);
      });
      return;
    }
    const dir = this.sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "metadata.json"), `${JSON.stringify(session, null, 2)}\n`);
  }

  /** Read one session descriptor by session id or qualified date/id selector. */
  async readSession(sessionId: string): Promise<TranscriptSessionDescriptor | undefined> {
    return (await this.readSessionEntry(sessionId))?.session;
  }

  /** Read one session descriptor plus its directory. */
  async readSessionEntry(sessionId: string): Promise<TranscriptsSessionEntry | undefined> {
    if (this.stateDb) {
      const qualified = sessionId.match(/^(\d{4}-\d{2}-\d{2})\/(.+)$/);
      if (qualified?.[1] && qualified[2]) {
        const row = this.dbGet(
          `SELECT * FROM transcript_sessions
           WHERE session_id = ? AND started_at LIKE ?`,
          [toSqlValue(qualified[2]), toSqlValue(`${qualified[1]}T%`)],
        );
        if (!row) {
          return undefined;
        }
        const session = sessionFromRow(row);
        return { session, sessionDir: this.sessionDir(session) };
      }
      const row = this.dbGet(
        "SELECT * FROM transcript_sessions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
        [toSqlValue(sessionId)],
      );
      if (!row) {
        return undefined;
      }
      const session = sessionFromRow(row);
      return { session, sessionDir: this.sessionDir(session) };
    }
    const dir = await this.findSessionDir(sessionId);
    if (!dir) {
      return undefined;
    }
    const session = await readJsonFile<TranscriptSessionDescriptor>(
      path.join(dir, "metadata.json"),
    );
    return session ? { session, sessionDir: dir } : undefined;
  }

  /** Append an utterance for an exact session descriptor. */
  async appendUtteranceForSession(
    session: TranscriptSessionDescriptor,
    utterance: TranscriptUtterance,
  ): Promise<void> {
    if (this.stateDb) {
      const ts = nowMs();
      runOpenClawStateWriteTransaction(() => {
        this.dbRun(
          `INSERT INTO transcript_utterances
           (session_id, session_started, utterance_id, speaker_label, speaker_id, text, started_at, ended_at,
            final, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toSqlValue(session.sessionId),
            toSqlValue(session.startedAt),
            toSqlValue(utterance.id),
            toSqlValue(utterance.speaker?.label),
            toSqlValue(utterance.speaker?.id),
            toSqlValue(utterance.text),
            toSqlValue(utterance.startedAt),
            toSqlValue(utterance.endedAt),
            toSqlValue(utterance.final !== false ? 1 : 0),
            toSqlValue(utterance.metadata ? JSON.stringify(utterance.metadata) : null),
            toSqlValue(ts),
          ],
        );
      });
      return;
    }
    const dir = await this.findSessionDirForSession(session);
    await this.appendUtteranceToDir(dir, session.sessionId, utterance);
  }

  private async appendUtteranceToDir(
    dir: string,
    sessionId: string,
    utterance: TranscriptUtterance,
  ): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, "transcript.jsonl"),
      `${JSON.stringify({ ...utterance, sessionId })}\n`,
    );
  }

  /** Read utterances for an exact session descriptor. */
  async readUtterancesForSession(
    session: TranscriptSessionDescriptor,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    if (this.stateDb) {
      return await this.readUtterancesFromSqlite(session.sessionId, session.startedAt, options);
    }
    return await this.readUtterancesFromDir(await this.findSessionDirForSession(session), options);
  }

  /** Read utterances directly from a known session directory. */
  async readUtterancesFromSessionDir(
    sessionDir: string,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    if (this.stateDb) {
      const dirName = path.basename(sessionDir);
      const parentDir = path.basename(path.dirname(sessionDir));
      const datePrefix = /^\d{4}-\d{2}-\d{2}$/.test(parentDir) ? parentDir : undefined;
      if (dirName) {
        const rows = await this.readUtterancesFromSqlite(
          dirName,
          datePrefix ? `${datePrefix}T` : undefined,
          options,
        );
        if (rows.length > 0) {
          return rows;
        }
      }
    }
    return await this.readUtterancesFromDir(sessionDir, options);
  }

  private async readUtterancesFromSqlite(
    sessionId: string,
    sessionStarted: string | undefined,
    options: { maxUtterances?: number },
  ): Promise<TranscriptUtterance[]> {
    const maxUtterances = resolveOptionalIntegerOption(options.maxUtterances, { min: 1 });
    const scoped = sessionStarted !== undefined;
    if (maxUtterances !== undefined) {
      const sql = scoped
        ? `SELECT * FROM transcript_utterances
           WHERE session_id = ? AND session_started LIKE ?
           ORDER BY id DESC LIMIT ?`
        : `SELECT * FROM transcript_utterances
           WHERE session_id = ?
           ORDER BY id DESC LIMIT ?`;
      const params: import("node:sqlite").SQLInputValue[] = scoped
        ? [toSqlValue(sessionId), toSqlValue(sessionStarted + "%"), toSqlValue(maxUtterances)]
        : [toSqlValue(sessionId), toSqlValue(maxUtterances)];
      const rows = this.dbExec(sql, params);
      return (rows as Record<string, unknown>[]).toReversed().map(utteranceFromRow);
    }
    const sql = scoped
      ? `SELECT * FROM transcript_utterances
         WHERE session_id = ? AND session_started LIKE ?
         ORDER BY id ASC`
      : `SELECT * FROM transcript_utterances
         WHERE session_id = ?
         ORDER BY id ASC`;
    const params: import("node:sqlite").SQLInputValue[] = scoped
      ? [toSqlValue(sessionId), toSqlValue(sessionStarted + "%")]
      : [toSqlValue(sessionId)];
    const rows = this.dbExec(sql, params);
    return (rows as Record<string, unknown>[]).map(utteranceFromRow);
  }

  private async readUtterancesFromDir(
    dir: string,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const maxUtterances = resolveOptionalIntegerOption(options.maxUtterances, { min: 1 });
    if (maxUtterances !== undefined) {
      return await new Promise<TranscriptUtterance[]>((resolve, reject) => {
        const utterances: TranscriptUtterance[] = [];
        const stream = createReadStream(transcriptPath, { encoding: "utf8" });
        const lines = createInterface({
          input: stream,
          crlfDelay: Infinity,
        });
        let settled = false;
        let emptyForENOENT = false;
        let pendingError: Error | undefined;

        const settle = () => {
          if (settled) {
            return;
          }
          settled = true;
          lines.close();
          stream.destroy();
          if (pendingError) {
            reject(pendingError);
          } else if (emptyForENOENT) {
            resolve([]);
          } else {
            resolve(utterances);
          }
        };
        const setError = (err: unknown) => {
          if (!pendingError) {
            pendingError = err instanceof Error ? err : new Error(String(err));
          }
        };

        stream.on("close", settle);
        stream.on("error", (err) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
            emptyForENOENT = true;
            return;
          }
          setError(err);
          stream.destroy();
        });
        lines.on("error", (err) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
            emptyForENOENT = true;
            return;
          }
          setError(err);
          stream.destroy();
        });
        lines.on("line", (line) => {
          if (!line) {
            return;
          }
          try {
            utterances.push(JSON.parse(line) as TranscriptUtterance);
          } catch (err) {
            setError(err);
            stream.destroy();
            return;
          }
          if (utterances.length > maxUtterances) {
            utterances.shift();
          }
        });
      });
    }
    let raw: string;
    try {
      raw = await fs.readFile(transcriptPath, "utf8");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptUtterance);
  }

  /** Mark a transcript session as stopped when metadata exists. */
  async updateStopped(sessionId: string, stoppedAt: string): Promise<void> {
    if (this.stateDb) {
      const qualified = sessionId.match(/^(\d{4}-\d{2}-\d{2})\/(.+)$/);
      if (qualified?.[1] && qualified[2]) {
        runOpenClawStateWriteTransaction(() => {
          this.dbRun(
            `UPDATE transcript_sessions SET stopped_at = ?, updated_at = ?
             WHERE session_id = ? AND started_at LIKE ?`,
            [
              toSqlValue(stoppedAt),
              toSqlValue(nowMs()),
              toSqlValue(qualified[2]),
              toSqlValue(`${qualified[1]}T%`),
            ],
          );
        });
        return;
      }
      runOpenClawStateWriteTransaction(() => {
        this.dbRun(
          `UPDATE transcript_sessions SET stopped_at = ?, updated_at = ?
           WHERE id = (
             SELECT id FROM transcript_sessions
             WHERE session_id = ? ORDER BY started_at DESC LIMIT 1
           )`,
          [toSqlValue(stoppedAt), toSqlValue(nowMs()), toSqlValue(sessionId)],
        );
      });
      return;
    }
    const dir = await this.findSessionDir(sessionId);
    if (!dir) {
      return;
    }
    const session = await readJsonFile<TranscriptSessionDescriptor>(
      path.join(dir, "metadata.json"),
    );
    if (!session) {
      return;
    }
    await fs.writeFile(
      path.join(dir, "metadata.json"),
      `${JSON.stringify({ ...session, stoppedAt }, null, 2)}\n`,
    );
  }

  /** Write summary artifacts for a session and return the markdown path. */
  async writeSummary(
    summary: TranscriptsSummary,
    session?: TranscriptSessionDescriptor,
  ): Promise<string> {
    const dir =
      session !== undefined
        ? this.stateDb
          ? this.sessionDir(session)
          : await this.findSessionDirForSession(session)
        : ((await this.findSessionDir(summary.sessionId)) ??
          path.join(this.rootDir, dateSegment(summary.sessionId), safeSegment(summary.sessionId)));
    return await this.writeSummaryToDir(summary, dir);
  }

  /** Write summary JSON and markdown to a known directory. */
  async writeSummaryToDir(summary: TranscriptsSummary, dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const markdown = renderTranscriptsMarkdown(summary);
    const markdownPath = path.join(dir, "summary.md");
    await fs.writeFile(markdownPath, `${markdown}\n`);
    return markdownPath;
  }
}

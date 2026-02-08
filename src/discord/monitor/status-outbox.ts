import type { RequestClient } from "@buape/carbon";
import type { DatabaseSync } from "node:sqlite";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { clampInt } from "../../utils.js";
import { sendMessageDiscord } from "../send.js";

export type DiscordStatusOutboxRow = {
  messageId: string;
  channelId: string;
  replyToId?: string | null;
  state: "working" | "done" | "error" | "aborted";
  createdAtMs: number;
  updatedAtMs: number;
};

const log = createSubsystemLogger("discord/status-outbox");

const DEFAULT_ABORT_AFTER_MS = 30_000;
const DEFAULT_WATCHDOG_MS = 120_000;
const DEFAULT_RETENTION_DAYS = 7;

export const DEFAULT_ABORT_MESSAGE =
  "Restart interrupted my reply. Please resend your last message if it still matters.";

function resolveOutboxPath(): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "discord", "status-outbox.sqlite");
}

function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  fsSync.mkdirSync(dir, { recursive: true });
}

function openDb(dbPath: string): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  ensureDirForFile(dbPath);
  return new DatabaseSync(dbPath);
}

function ensureSchema(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS outbox (" +
      "message_id TEXT PRIMARY KEY, " +
      "channel_id TEXT NOT NULL, " +
      "reply_to_id TEXT, " +
      "state TEXT NOT NULL, " +
      "created_at_ms INTEGER NOT NULL, " +
      "updated_at_ms INTEGER NOT NULL" +
      ");",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_state_updated ON outbox(state, updated_at_ms);");
}

export type DiscordStatusOutboxConfig = {
  enabled: boolean;
  abortAfterMs: number;
  watchdogMs: number;
  retentionDays: number;
  abortMessage: string;
};

export function resolveDiscordStatusOutboxConfig(cfg: OpenClawConfig): DiscordStatusOutboxConfig {
  const statusCfg = cfg.channels?.discord?.statusReactions;
  const enabled = statusCfg?.enabled === true && statusCfg?.outbox?.enabled !== false;
  const abortAfterMs = clampInt(
    (statusCfg?.outbox?.abortAfterSeconds ?? DEFAULT_ABORT_AFTER_MS / 1000) * 1000,
    5_000,
    10 * 60_000,
  );
  const watchdogMs = clampInt(
    (statusCfg?.outbox?.watchdogSeconds ?? DEFAULT_WATCHDOG_MS / 1000) * 1000,
    10_000,
    60 * 60_000,
  );
  const retentionDays = clampInt(
    statusCfg?.outbox?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    1,
    365,
  );
  const abortMessage = (statusCfg?.outbox?.abortMessage ?? DEFAULT_ABORT_MESSAGE).trim();
  return { enabled, abortAfterMs, watchdogMs, retentionDays, abortMessage };
}

export class DiscordStatusOutbox {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? resolveOutboxPath();
    this.db = openDb(this.dbPath);
    ensureSchema(this.db);
  }

  upsertWorking(params: { messageId: string; channelId: string; replyToId?: string | null }) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO outbox (message_id, channel_id, reply_to_id, state, created_at_ms, updated_at_ms) " +
          "VALUES (?, ?, ?, 'working', ?, ?) " +
          "ON CONFLICT(message_id) DO UPDATE SET " +
          "channel_id=excluded.channel_id, reply_to_id=excluded.reply_to_id, state='working', updated_at_ms=excluded.updated_at_ms",
      )
      .run(params.messageId, params.channelId, params.replyToId ?? null, now, now);
  }

  markTerminal(params: { messageId: string; state: "done" | "error" | "aborted" }) {
    const now = Date.now();
    this.db
      .prepare("UPDATE outbox SET state = ?, updated_at_ms = ? WHERE message_id = ?")
      .run(params.state, now, params.messageId);
  }

  listStaleWorking(cutoffMs: number): DiscordStatusOutboxRow[] {
    const rows = this.db
      .prepare(
        "SELECT message_id as messageId, channel_id as channelId, reply_to_id as replyToId, state, created_at_ms as createdAtMs, updated_at_ms as updatedAtMs " +
          "FROM outbox WHERE state = 'working' AND updated_at_ms <= ? ORDER BY updated_at_ms ASC LIMIT 200",
      )
      .all(cutoffMs) as DiscordStatusOutboxRow[];
    return rows;
  }

  prune(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    this.db
      .prepare("DELETE FROM outbox WHERE state != 'working' AND updated_at_ms <= ?")
      .run(cutoff);
  }

  close() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.db as any).close?.();
    } catch {
      // ignore
    }
  }
}

export async function reconcileDiscordStatusOutbox(params: {
  cfg: OpenClawConfig;
  outbox: DiscordStatusOutbox;
  rest: RequestClient;
  token: string;
  accountId?: string;
  errorEmoji: string;
  allStateEmojis: string[];
  setErrorReaction: (p: { channelId: string; messageId: string }) => Promise<void>;
}) {
  const outboxCfg = resolveDiscordStatusOutboxConfig(params.cfg);
  if (!outboxCfg.enabled) {
    return;
  }

  // First: prune old terminals.
  params.outbox.prune(outboxCfg.retentionDays);

  const cutoff = Date.now() - outboxCfg.abortAfterMs;
  const stale = params.outbox.listStaleWorking(cutoff);
  if (stale.length === 0) {
    return;
  }

  for (const row of stale) {
    try {
      await params.setErrorReaction({ channelId: row.channelId, messageId: row.messageId });
      if (outboxCfg.abortMessage) {
        await sendMessageDiscord(`channel:${row.channelId}`, outboxCfg.abortMessage, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo: row.messageId,
        });
      }
    } catch (err) {
      log.warn(`reconcile failed for ${row.channelId}/${row.messageId}: ${String(err)}`);
    } finally {
      params.outbox.markTerminal({ messageId: row.messageId, state: "aborted" });
    }
  }
}

import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
const VOICEWAKE_CONFIG_KEY = "triggers";

type VoiceWakeDatabase = Pick<OpenClawStateKyselyDatabase, "voicewake_triggers">;

function sqliteOptionsForBaseDir(baseDir: string | undefined): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => normalizeOptionalString(w) ?? "")
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

export async function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig> {
  const database = openOpenClawStateDatabase(sqliteOptionsForBaseDir(baseDir));
  const db = getNodeSqliteKysely<VoiceWakeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("voicewake_triggers")
      .select(["trigger", "updated_at_ms"])
      .where("config_key", "=", VOICEWAKE_CONFIG_KEY)
      .orderBy("position", "asc"),
  ).rows;
  if (rows.length === 0) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  const updatedAtMs = Math.max(
    ...rows.map((row) =>
      typeof row.updated_at_ms === "bigint" ? Number(row.updated_at_ms) : row.updated_at_ms,
    ),
  );
  return {
    triggers: sanitizeTriggers(rows.map((row) => row.trigger)),
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
  };
}

export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  const next: VoiceWakeConfig = {
    triggers: sanitized,
    updatedAtMs: Date.now(),
  };
  writeVoiceWakeConfigSnapshot(next, baseDir);
  return next;
}

export function normalizeVoiceWakeConfigSnapshot(raw: unknown): VoiceWakeConfig {
  const updatedAtMs = (raw as Partial<VoiceWakeConfig> | undefined)?.updatedAtMs;
  return {
    triggers: sanitizeTriggers((raw as Partial<VoiceWakeConfig> | undefined)?.triggers),
    updatedAtMs: typeof updatedAtMs === "number" && updatedAtMs > 0 ? updatedAtMs : 0,
  };
}

export function writeVoiceWakeConfigSnapshot(config: VoiceWakeConfig, baseDir?: string): void {
  const triggers = sanitizeTriggers(config.triggers);
  const updatedAtMs = config.updatedAtMs > 0 ? Math.floor(config.updatedAtMs) : 0;
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<VoiceWakeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("voicewake_triggers").where("config_key", "=", VOICEWAKE_CONFIG_KEY),
    );
    for (const [position, trigger] of triggers.entries()) {
      executeSqliteQuerySync(
        database.db,
        db.insertInto("voicewake_triggers").values({
          config_key: VOICEWAKE_CONFIG_KEY,
          position,
          trigger,
          updated_at_ms: updatedAtMs,
        }),
      );
    }
  }, sqliteOptionsForBaseDir(baseDir));
}

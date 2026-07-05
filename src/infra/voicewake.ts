// Stores voice wake trigger configuration.
<<<<<<< HEAD
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
=======
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, tryReadJson, writeJson } from "./json-files.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

// Voice wake config stores trigger words used by local voice integrations.
type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
<<<<<<< HEAD
const VOICEWAKE_CONFIG_KEY = "default";

type VoiceWakeDatabase = Pick<OpenClawStateKyselyDatabase, "voicewake_triggers">;
=======

function resolvePath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake.json");
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => normalizeOptionalString(w) ?? "")
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

<<<<<<< HEAD
function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}
=======
const withLock = createAsyncLock();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/** Return the built-in voice wake trigger list. */
export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

/** Load persisted voice wake triggers, falling back to defaults. */
export async function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig> {
<<<<<<< HEAD
  const database = openStateDatabase(baseDir);
  const voicewakeDb = getNodeSqliteKysely<VoiceWakeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    voicewakeDb
      .selectFrom("voicewake_triggers")
      .select(["trigger", "updated_at_ms"])
      .where("config_key", "=", VOICEWAKE_CONFIG_KEY)
      .orderBy("position", "asc"),
  ).rows;
  if (rows.length === 0) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(rows.map((row) => row.trigger)),
    updatedAtMs: Math.max(0, ...rows.map((row) => row.updated_at_ms)),
=======
  const filePath = resolvePath(baseDir);
  const existing = await tryReadJson<VoiceWakeConfig>(filePath);
  if (!existing) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(existing.triggers),
    updatedAtMs:
      typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0
        ? existing.updatedAtMs
        : 0,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  };
}

/** Persist the configured voice wake trigger list. */
export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
<<<<<<< HEAD
  const updatedAtMs = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const voicewakeDb = getNodeSqliteKysely<VoiceWakeDatabase>(db);
      executeSqliteQuerySync(
        db,
        voicewakeDb.deleteFrom("voicewake_triggers").where("config_key", "=", VOICEWAKE_CONFIG_KEY),
      );
      executeSqliteQuerySync(
        db,
        voicewakeDb.insertInto("voicewake_triggers").values(
          sanitized.map((trigger, position) => ({
            config_key: VOICEWAKE_CONFIG_KEY,
            position,
            trigger,
            updated_at_ms: updatedAtMs,
          })),
        ),
      );
    },
    baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
  );
  return {
    triggers: sanitized,
    updatedAtMs,
  };
=======
  const filePath = resolvePath(baseDir);
  return await withLock(async () => {
    const next: VoiceWakeConfig = {
      triggers: sanitized,
      updatedAtMs: Date.now(),
    };
    await writeJson(filePath, next);
    return next;
  });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

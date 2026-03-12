/**
 * One-shot migration: teams.json → SQLite.
 *
 * Reads ~/.openclaw/teams/teams.json, inserts runs/tasks/messages into
 * the normalized op1_team_* tables, then deletes the source file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../infra/state-db/connection.js";
import { appendTeamMessageToDb, saveTeamRunToDb, saveTeamTaskToDb } from "./team-store-sqlite.js";
import type { TeamStoreData } from "./types.js";

type MigrationResult = {
  runsCount: number;
  tasksCount: number;
  messagesCount: number;
  migrated: boolean;
  error?: string;
};

export function migrateTeamStoreToSqlite(
  env?: NodeJS.ProcessEnv,
  db?: DatabaseSync,
): MigrationResult {
  const storeFile = path.join(os.homedir(), ".openclaw", "teams", "teams.json");
  const _db = db ?? getStateDb(env);

  if (!fs.existsSync(storeFile)) {
    return { runsCount: 0, tasksCount: 0, messagesCount: 0, migrated: true };
  }

  let runsCount = 0;
  let tasksCount = 0;
  let messagesCount = 0;

  try {
    const raw = fs.readFileSync(storeFile, "utf-8");
    const data = JSON.parse(raw) as TeamStoreData;

    // Migrate runs (which includes members)
    for (const run of Object.values(data.runs)) {
      saveTeamRunToDb(run, _db);
      runsCount++;
    }

    // Migrate tasks
    for (const [_teamRunId, taskList] of Object.entries(data.tasks)) {
      for (const task of taskList) {
        saveTeamTaskToDb(task, _db);
        tasksCount++;
      }
    }

    // Migrate messages
    for (const [_teamRunId, msgList] of Object.entries(data.messages)) {
      for (const msg of msgList) {
        appendTeamMessageToDb(msg, _db);
        messagesCount++;
      }
    }

    // Delete source file
    fs.unlinkSync(storeFile);

    // Clean up empty directory
    try {
      const dir = path.dirname(storeFile);
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // Best-effort
    }
  } catch (err) {
    return {
      runsCount,
      tasksCount,
      messagesCount,
      migrated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { runsCount, tasksCount, messagesCount, migrated: true };
}

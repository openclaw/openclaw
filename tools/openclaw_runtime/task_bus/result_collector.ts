import path from "node:path";
import Database from "better-sqlite3";
import type { TaskResult } from "./task_schema.js";

const DEFAULT_DB_PATH = path.join(process.cwd(), ".claude/evolution-state/nuwa.db");

interface LearningEventRow {
  event_type: string;
  payload: string;
  source: string;
  pattern_slug: string | null;
}

function buildRow(result: TaskResult): LearningEventRow {
  return {
    event_type: `task_${result.status}`,
    payload: JSON.stringify({
      route: result.route,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      changedFiles: result.changedFiles,
      commandsRun: result.commandsRun,
      risks: result.risks,
      error: result.error,
    }),
    source: result.source,
    pattern_slug: null,
  };
}

function insertRow(db: Database.Database, row: LearningEventRow): void {
  db.prepare(
    `INSERT INTO learning_events (event_type, payload, source, pattern_slug, created_at)
     VALUES (@event_type, @payload, @source, @pattern_slug, datetime('now'))`,
  ).run(row);
}

export async function collectResult(
  result: TaskResult,
  dbPath: string = DEFAULT_DB_PATH,
): Promise<void> {
  const db = new Database(dbPath);
  try {
    insertRow(db, buildRow(result));
  } finally {
    db.close();
  }
}

export async function collectResults(
  results: TaskResult[],
  dbPath: string = DEFAULT_DB_PATH,
): Promise<void> {
  const db = new Database(dbPath);
  try {
    const insertMany = db.transaction((rows: LearningEventRow[]) => {
      for (const row of rows) insertRow(db, row);
    });
    insertMany(results.map(buildRow));
  } finally {
    db.close();
  }
}

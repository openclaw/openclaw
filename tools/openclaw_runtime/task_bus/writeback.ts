import fs from "node:fs";
import type Database from "better-sqlite3";
import type { TaskResult } from "./task_schema.js";

const CAUSAL_UPSERT_SQL = `
  INSERT INTO causal_edges (from_slug, to_slug, relation, weight, valid_from, valid_to)
  VALUES (@from_slug, @to_slug, @relation, @weight, datetime('now'), NULL)
  ON CONFLICT(from_slug, to_slug, relation)
  DO UPDATE SET weight = @weight, valid_from = datetime('now'), valid_to = NULL
`;

const CAUSAL_PENALIZE_SQL = `
  UPDATE causal_edges
  SET weight = MAX(0, weight - 0.2), valid_to = datetime('now')
  WHERE from_slug = @from_slug AND relation = 'hermes_success'
`;

export function writebackToCausal(result: TaskResult, db: Database.Database): void {
  try {
    if (result.status === "succeeded") {
      db.prepare(CAUSAL_UPSERT_SQL).run({
        from_slug: result.traceId,
        to_slug: result.route,
        relation: "task_success",
        weight: 0.1,
      });
    } else if (result.status === "failed") {
      db.prepare(CAUSAL_PENALIZE_SQL).run({ from_slug: result.traceId });
    }
  } catch (err) {
    console.error("[writeback] writebackToCausal error:", err);
  }
}

interface LearningState {
  success_patterns?: string[];
  failure_patterns?: string[];
}

export function syncHermesToCausal(db: Database.Database, learningStatePath: string): void {
  try {
    if (!fs.existsSync(learningStatePath)) return;

    const raw = fs.readFileSync(learningStatePath, "utf-8");
    const state: LearningState = JSON.parse(raw);

    const upsert = db.prepare(CAUSAL_UPSERT_SQL);
    const penalize = db.prepare(CAUSAL_PENALIZE_SQL);

    const sync = db.transaction(() => {
      for (const slug of state.success_patterns ?? []) {
        upsert.run({
          from_slug: slug,
          to_slug: "hermes",
          relation: "hermes_success",
          weight: 1.0,
        });
      }
      for (const slug of state.failure_patterns ?? []) {
        penalize.run({ from_slug: slug });
      }
    });

    sync();
  } catch (err) {
    console.error("[writeback] syncHermesToCausal error:", err);
  }
}

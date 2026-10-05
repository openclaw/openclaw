import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { migrateWorkerRepositoryReadiness } from "./openclaw-state-db-repository-readiness-migration.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

it("preserves accepted placement and turn ownership while admitting separate repository readiness", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const legacy = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "worker_session_placements")
      .replace(
        "  repository_preparation TEXT CHECK (repository_preparation IN ('pending', 'ready', 'failed')),\n",
        "",
      )
      .replace(
        / {2}CHECK \(repository_preparation IS NULL OR[\s\S]*?state IN \('starting', 'active', 'draining', 'reconciling', 'reclaimed', 'failed'\)\)\),\n/u,
        "",
      )
      .replaceAll(
        "(workspace_base_manifest_ref IS NOT NULL OR repository_preparation IS 'pending' OR repository_preparation IS 'failed')",
        "workspace_base_manifest_ref IS NOT NULL",
      );
    db.exec(legacy);
    db.exec(
      `INSERT INTO worker_session_placements (session_id, agent_id, session_key, execution_mode, state, environment_id, transition_generation, active_owner_epoch, workspace_base_manifest_ref, remote_workspace_dir, worker_bundle_hash, turn_claim_owner, turn_claim_id, turn_claim_run_id, turn_claim_generation, turn_claim_owner_epoch, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('session', 'main', 'agent:main:fixture', 'worker-turn', 'active', 'environment', 5, 7, 'accepted-manifest', '/exact/branch', 'bundle', 'worker', 'claim', 'run', 5, 7, 1, 2, 2);`,
    );
    const before = db.prepare("SELECT * FROM worker_session_placements").get();
    db.exec("BEGIN");
    expect(migrateWorkerRepositoryReadiness(db, 20)).toBe(true);
    db.exec("COMMIT");
    expect(db.prepare("SELECT * FROM worker_session_placements").get()).toEqual({
      ...before,
      repository_preparation: null,
    });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(() =>
      db.exec("UPDATE worker_session_placements SET workspace_base_manifest_ref = NULL"),
    ).toThrow();
    expect(migrateWorkerRepositoryReadiness(db, 21)).toBe(false);
    db.exec(
      "UPDATE worker_session_placements SET workspace_base_manifest_ref = NULL, repository_preparation = 'pending'",
    );
    expect(
      db
        .prepare(
          "SELECT active_owner_epoch, turn_claim_id, repository_preparation FROM worker_session_placements",
        )
        .get(),
    ).toEqual({ active_owner_epoch: 7, turn_claim_id: "claim", repository_preparation: "pending" });
  } finally {
    db.close();
  }
});

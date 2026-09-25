import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "./store.js";
import { cronStoreKey } from "./store/key.js";

it("reads a pre-projection cron table without writable schema repair", async () => {
  await withOpenClawTestState({ prefix: "openclaw-cron-readonly-upgrade-" }, async (state) => {
    const storePath = path.join(state.stateDir, "cron", "jobs.json");
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const now = Date.now();
    const job = {
      id: "legacy-reader",
      name: "Legacy reader",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    } as const;
    const { state: jobState, updatedAtMs, ...jobDefinition } = job;
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE cron_jobs (
          store_key TEXT NOT NULL,
          job_id TEXT NOT NULL,
          declaration_key TEXT,
          owner_agent_id TEXT,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER NOT NULL,
          agent_id TEXT,
          payload_kind TEXT NOT NULL,
          job_json TEXT NOT NULL,
          state_json TEXT NOT NULL DEFAULT '{}',
          runtime_updated_at_ms INTEGER,
          schedule_identity TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id)
        ) STRICT;
      `);
      database
        .prepare(
          `INSERT INTO cron_jobs (
             store_key, job_id, declaration_key, owner_agent_id, name, description,
             enabled, agent_id, payload_kind, job_json, state_json,
             runtime_updated_at_ms, schedule_identity, sort_order, updated_at
           ) VALUES (?, ?, NULL, NULL, ?, NULL, 1, NULL, ?, ?, ?, ?, NULL, 0, ?)`,
        )
        .run(
          cronStoreKey(storePath),
          job.id,
          job.name,
          job.payload.kind,
          JSON.stringify({ ...jobDefinition, state: {} }),
          JSON.stringify(jobState),
          updatedAtMs,
          updatedAtMs,
        );
    } finally {
      database.close();
    }

    const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
    expect(loaded.store.jobs).toMatchObject([
      { id: job.id, name: job.name, enabled: true, payload: job.payload },
    ]);

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columnNames = inspection
        .prepare("PRAGMA table_info(cron_jobs)")
        .all()
        .map((row) => row.name);
      expect(columnNames).not.toContain("grant_definition_revision");
      expect(columnNames).not.toContain("grant_definition_generation");
      expect(columnNames).not.toContain("grant_definition_updated_at");
    } finally {
      inspection.close();
    }
  });
});

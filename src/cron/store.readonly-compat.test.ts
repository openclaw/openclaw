import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { withCronStore } from "./store.worker.test-support.js";
import { cronStoreKey } from "./store/key.js";

it("reads a pre-projection cron table without writable schema repair", async () => {
  await withCronStore("cron-readonly-upgrade", async (state) => {
    const { storePath, databasePath } = state;
    const job = makeCronJob({
      id: "legacy-reader",
      name: "Legacy reader",
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });
    const { state: jobState, updatedAtMs, ...jobDefinition } = job;
    await state.createDatabase(`
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
    const database = new DatabaseSync(databasePath);
    try {
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

    const loaded = await state.read();
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

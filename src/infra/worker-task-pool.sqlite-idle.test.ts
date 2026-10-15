import { expect, it } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureSqliteDatabaseAdmissions } from "./sqlite-database-admission.js";
import { getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "./worker-task-pool.js";
import type {
  SqliteIdleInput,
  SqliteIdleReply,
} from "./worker-task-pool.sqlite-idle.test-support.js";

it("preserves schema admission when an SDK read-only worker retires with a retained reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { db, path } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const schema = getAdmittedSqliteSchemaFacts(db);
    expect(schema).toBeDefined();
    const pool = new WorkerTaskPool<SqliteIdleInput, SqliteIdleReply>({
      workerUrl: new URL("./worker-task-pool.sqlite-idle.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
      databaseAccess: "read-only",
    });
    try {
      expect(await pool.run({ path }, {})).toMatchObject({ retained: true, open: true });
      await pool.close();
      expect(getAdmittedSqliteSchemaFacts(db)?.admissionId).toBe(schema?.admissionId);
    } finally {
      await pool.close();
      await closeOpenClawAgentDatabaseByPathAsync(path);
    }
  });
});

it("retires a cold-imported reader after its task, then reopens and explicitly closes in the same worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const pool = createOwnedWorkerTaskPool<SqliteIdleInput, SqliteIdleReply>({
      workerUrl: new URL("./worker-task-pool.sqlite-idle.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    });
    try {
      const first = await pool.run({ path }, {});
      expect(first).toMatchObject({ retained: true, open: true, reused: false });
      const record = captureSqliteDatabaseAdmissions().find((entry) => entry.location === path)!;
      const reference = new Int32Array(record.references.get(first.threadId)!);
      expect(Atomics.load(reference, 0)).toBe(1);
      expect(await pool.run({ path }, {})).toEqual({ ...first, reused: true });

      expect(await pool.run({ expire: true }, {})).toEqual({
        threadId: first.threadId,
        retained: false,
        open: false,
      });
      // Observe release before worker termination can repair a leaked reference.
      expect(Atomics.load(reference, 0)).toBe(0);
      const reopened = openOpenClawAgentDatabase(options);
      expect(reopened.db.isOpen).toBe(true);
      await closeOpenClawAgentDatabaseByPathAsync(path);

      expect(await pool.run({ path }, {})).toEqual(first);
      const nextRecord = captureSqliteDatabaseAdmissions().find(
        (entry) => entry.location === path,
      )!;
      const nextReference = new Int32Array(nextRecord.references.get(first.threadId)!);
      expect(Atomics.load(nextReference, 0)).toBe(1);
      await pool.closeResources();
      expect(Atomics.load(nextReference, 0)).toBe(0);
      expect(await pool.run({ expire: true }, {})).toEqual({
        threadId: first.threadId,
        retained: false,
        open: false,
      });
    } finally {
      await pool.close();
    }
  });
});

import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preparePostgresRestore } from "../snapshot/database-backup.js";
import { withDatabasePortPostgres } from "./database-engine/port-provider.js";
import { admitDatabasePortDescriptor } from "./database-engine/port.worker.js";
import {
  assertPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
} from "./database-engine/postgres-catalog.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { quoteSqliteIdentifier as quote } from "./sqlite-schema-sql.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

type Task = {
  directory: string;
  anchorPath: string;
  config: OpenClawConfig;
  expectedSource: { storeId: string; namespace: string };
  preserveUpdateHistory: boolean;
};
type Reply = Awaited<ReturnType<typeof preparePostgresRestore>>;

/** The caller retains R14a custody until the restored anchor is published. */
export async function prepareUpdatePostgresRestore(
  task: Task,
  assertCurrent: () => void,
): Promise<Reply> {
  assertCurrent();
  const source = captureRuntimeWorkerSource(new URL(import.meta.url));
  const pool = new WorkerTaskPool<Task, Reply>({
    workerUrl: source.moduleUrl,
    maxWorkers: 1,
    workerOptions: { workerData: { updatePostgresRestore: true } },
  });
  try {
    const restored = await pool.run(task, {});
    assertCurrent();
    return restored;
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.updatePostgresRestore === true) {
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  serveWorkerTasks<Reply>(async (value) => {
    // SAFETY: The owning updater supplies this typed task under exclusive custody.
    const task = value as Task;
    const restored = await preparePostgresRestore({
      ...task,
      profile: "exact",
      assertCurrent() {},
    });
    if (task.preserveUpdateHistory) {
      await withDatabasePortPostgres(task.config, task.expectedSource, async (client, base) => {
        const source = task.expectedSource.namespace;
        const descriptor = await admitDatabasePortDescriptor(
          { engine: "postgres", db: client, namespace: source },
          base,
        );
        const table = descriptor.tables.find((entry) => entry.name === "update_runs");
        if (!table) {
          throw new Error(
            "PostgreSQL rollback cannot preserve the current update history contract.",
          );
        }
        const expected = descriptor.expectedCatalog.filter((fact) => fact.table === table.name);
        for (const namespace of [source, restored.namespace]) {
          const catalog = readPostgresCatalog(
            (await client.query(postgresCatalogQuery(namespace))).rows[0].catalog,
          );
          assertPostgresCatalog(
            catalog.filter((fact) => fact.table === table.name),
            expected,
          );
        }
        const columns = table.columns.map(({ name }) => quote(name)).join(", ");
        await client.query("BEGIN; SET LOCAL synchronous_commit = on");
        try {
          await client.query(`DELETE FROM ${quote(restored.namespace)}.update_runs`);
          await client.query(
            `INSERT INTO ${quote(restored.namespace)}.update_runs (${columns}) SELECT ${columns} FROM ${quote(source)}.update_runs`,
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    }
    return restored;
  });
}

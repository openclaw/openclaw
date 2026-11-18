import path from "node:path";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import type { WorkerFixtureOperations } from "./io.worker-backend.test-support.js";

/** Keep worker VMs warm while each config case still drains its own database actors. */
export function createConfigIoWorkerFixture() {
  const stores: SqliteWorkerStore<WorkerFixtureOperations>[] = [];
  return {
    async setup(root: string) {
      // Bun's broker deliberately dedicates a VM to each actor for native close safety.
      if (process.versions.bun) {
        return;
      }
      const threads = new Set<number>();
      // The broker caps Node at eight threads; the next open must reuse one.
      for (let index = 0; index < 9; index++) {
        const store = await openSqliteWorkerStore<WorkerFixtureOperations>({
          moduleUrl: new URL("./io.worker-backend.test-support.ts", import.meta.url),
          databasePath: path.join(root, `worker-${stores.length}.sqlite`),
          input: undefined,
        });
        stores.push(store);
        const threadId = await store.execute({ type: "threadId", input: undefined });
        if (threads.has(threadId)) {
          await store.close();
          stores.pop();
          return;
        }
        threads.add(threadId);
      }
      throw new Error("Config fixture did not reach the shared SQLite worker pool");
    },
    async close() {
      const results = await Promise.allSettled([closeOpenClawStateDatabaseAsync()]);
      results.push(...(await Promise.allSettled(stores.map((store) => store.close()))));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Config fixture worker cleanup failed");
      }
      stores.length = 0;
    },
  };
}

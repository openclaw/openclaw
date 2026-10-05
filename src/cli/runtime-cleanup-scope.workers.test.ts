import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withCliCommandCleanup, withCliProcessScope } from "./runtime-cleanup-scope.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    await closeDefaultRetainedNativeWorkerSource();
    cleanup();
  }),
);

it("joins shared-state workers after executable cleanup while preserving borrowed lifetimes", async () => {
  const root = directories.make("openclaw-cli-worker-exit-");
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
  };
  await closeOpenClawStateDatabaseAsync();
  await closeDefaultRetainedNativeWorkerSource();
  const database = openOpenClawStateDatabase(options);
  const stateKey = "cli.worker-exit.fixture";
  database.db
    .prepare(
      "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run(stateKey, '"retained for disposal"', 1);
  const read = () =>
    executeExistingOpenClawStateRead(options, { type: "tui.lastSession.read", stateKey });

  await withCliCommandCleanup(false, async () => {});
  expect(database.db.isOpen).toBe(true);
  await withCliProcessScope(() => withCliCommandCleanup(true, async () => {}));
  expect(database.db.isOpen).toBe(true);

  const workers: Worker[] = [];
  const captureWorker = (worker: Worker) => workers.push(worker);
  process.on("worker", captureWorker);
  let disposalRead: Awaited<ReturnType<typeof read>>;
  try {
    await withCliProcessScope(() =>
      withCliCommandCleanup(false, async (cleanup) => {
        try {
          expect(await read()).toMatchObject({
            ok: true,
            row: { value_json: '"retained for disposal"' },
          });
          expect(workers.some((worker) => worker.threadId !== -1)).toBe(true);
          cleanup?.pluginResources?.adopt({
            async release() {
              disposalRead = await read();
            },
          });
        } finally {
          await cleanup?.pluginResources?.release();
        }
      }),
    );

    expect(disposalRead).toMatchObject({
      ok: true,
      row: { value_json: '"retained for disposal"' },
    });
    expect.soft(database.db.isOpen).toBe(false);
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
  } finally {
    process.removeListener("worker", captureWorker);
  }
});

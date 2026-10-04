import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
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
  const baseline = getTrackedWorkerLifecycleSnapshot().workerCount;
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

  let disposalRead: Awaited<ReturnType<typeof read>>;
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      try {
        expect(await read()).toMatchObject({
          ok: true,
          row: { value_json: '"retained for disposal"' },
        });
        expect(getTrackedWorkerLifecycleSnapshot().workerCount).toBeGreaterThan(baseline);
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

  expect(disposalRead).toMatchObject({ ok: true, row: { value_json: '"retained for disposal"' } });
  expect.soft(database.db.isOpen).toBe(false);
  expect(getTrackedWorkerLifecycleSnapshot().workerCount).toBe(baseline);
});

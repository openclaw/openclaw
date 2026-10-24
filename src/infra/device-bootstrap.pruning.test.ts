import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import * as state from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as schedulers from "../test-utils/gateway-scheduler-clock.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion as consumeSetup,
  issueDevicePairSetupBootstrapToken as issueSetup,
  readDevicePairSetupCompletion as readSetup,
  startDevicePairSetupMaintenance as startMaintenance,
  verifyDeviceBootstrapToken as verify,
} from "./device-bootstrap.js";
import { deviceBootstrapOperations as operations } from "./device-bootstrap.worker-kernel.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it("keeps idle setup cleanup read-only and reports its expiry fact", async () => {
  const baseDir = await createTempDir();
  const env = { ...process.env, OPENCLAW_STATE_DIR: baseDir };
  const database = state.openOpenClawStateDatabase({ env });
  const options = { database, env };
  const statements = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["expiry", "prune"],
    (sql) =>
      /^select "retain_until_ms" from "device_pair_setup_completions"/iu.test(sql)
        ? "expiry"
        : /^delete from "device_pair_setup_completions"/iu.test(sql)
          ? "prune"
          : null,
  );
  using cleanup = new DisposableStack();
  cleanup.defer(statements.restore);
  const execute = cleanup.use(vi.spyOn(database.db, "exec"));
  // Observe command SQL locally; the worker cases below exercise the live host port.
  for (const method of [
    "requestSqliteWorkerOperationAdmission",
    "deferSqliteWorkerCommitReceipt",
  ] as const) {
    cleanup.use(vi.spyOn(workerAdmission, method).mockImplementation(() => undefined));
  }
  const result = runWithSqliteWorkerStateContext({ environment: env }, () =>
    operations["bootstrap.prune"](
      { nowMs: 1_000 },
      {
        open: () => state.openOpenClawStateDatabase(options),
        stateOptions: () => ({ path: database.path, env }),
        write: (operation) => state.runOpenClawStateWriteTransaction(operation, options),
        writeAdmitted: () => {
          throw new Error("Bootstrap pruning retains its custom admission");
        },
      },
    ),
  );
  expect(result).toMatchObject({ removed: 0, nextExpiryAtMs: null });
  expect(statements.counts).toEqual({ expiry: 1, prune: 0 });
  expect(execute.mock.calls.some(([sql]) => /^(?:BEGIN|SAVEPOINT)\b/iu.test(sql))).toBe(false);
});

it("refreshes the host expiry cache after a worker write and prunes at its deadline", async () => {
  const baseDir = await createTempDir();
  await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
    const recordedAtMs = Date.now();
    const clock = schedulers.createGatewaySchedulerClock(recordedAtMs);
    let scheduler = schedulers.createTestGatewayScheduler(clock.clock);
    const dateNow = vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    const onError = vi.fn();
    const retainedIdsSql = "SELECT setup_id FROM device_pair_setup_completions ORDER BY setup_id";
    const readRetainedSetupIds = () =>
      state.openOpenClawStateDatabase().db.prepare(retainedIdsSql).all();
    try {
      startMaintenance({ scheduler: scheduler.scope(), onError });
      await clock.wake();
      expect(clock.armedAtMs).toBeNull();
      const profile = NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE;
      const { token, setupId } = await issueSetup({ baseDir, profile });
      const credential = { baseDir, token, deviceId: "device-123" };
      const completion = () => readSetup({ baseDir, setupId });
      const expiresAtMs = recordedAtMs + 20 * 60 * 1000;
      await verify({ ...credential, publicKey: "public-key-123", role: "node", scopes: [] });
      await consumeSetup({ ...credential, completedAtMs: recordedAtMs });
      const completionFact = { setupId, deviceId: "device-123", retainUntilMs: expiresAtMs };
      await expect(completion()).resolves.toMatchObject(completionFact);
      await clock.wake();
      expect(clock.armedAtMs).toBe(expiresAtMs);

      await clock.advanceTo(expiresAtMs - 1);
      expect(readRetainedSetupIds()).toEqual([{ setup_id: setupId }]);
      await clock.advanceTo(expiresAtMs);
      // The status reader also prunes; inspect storage before invoking it.
      expect(readRetainedSetupIds()).toEqual([]);
      await expect(completion()).resolves.toBeNull();
      await scheduler.stop();
      await state.closeOpenClawStateDatabaseAsync();
      const { db } = state.openOpenClawStateDatabase();
      db.prepare(
        "INSERT INTO device_pair_setup_completions (setup_id, device_id, access, completed_at_ms, delivery_state, retain_until_ms) VALUES ('restart-expired', 'device-123', 'node', 1, 'confirmed', ?)",
      ).run(recordedAtMs);
      await state.closeOpenClawStateDatabaseAsync();
      scheduler = schedulers.createTestGatewayScheduler(clock.clock);
      startMaintenance({ scheduler: scheduler.scope(), onError });
      await clock.wake();
      expect(readRetainedSetupIds()).toEqual([]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      await scheduler.stop();
    }
  });
});

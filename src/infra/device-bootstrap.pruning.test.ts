import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  issueDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion,
  startDevicePairSetupMaintenance,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { deviceBootstrapOperations } from "./device-bootstrap.worker-kernel.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device setup completion pruning", () => {
  it("keeps idle setup cleanup read-only and reports its expiry fact", async () => {
    const baseDir = await createTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: baseDir };
    const database = openOpenClawStateDatabase({ env });
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
    const execute = vi.spyOn(database.db, "exec");
    // Observe command SQL locally; the worker cases below exercise the live host port.
    const admission = vi
      .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => undefined);
    const publication = vi
      .spyOn(workerAdmission, "deferSqliteWorkerCommitReceipt")
      .mockImplementation(() => undefined);
    const prune = (nowMs: number) =>
      runWithSqliteWorkerStateContext({ environment: env }, () =>
        deviceBootstrapOperations["bootstrap.prune"](
          { nowMs },
          {
            open: () => openOpenClawStateDatabase({ database, env }),
            stateOptions: () => ({ path: database.path, env }),
            write: (operation) => runOpenClawStateWriteTransaction(operation, { database, env }),
            writeAdmitted: () => {
              throw new Error("Bootstrap pruning retains its custom admission");
            },
          },
        ),
      );
    try {
      expect(prune(1_000)).toMatchObject({ removed: 0, nextExpiryAtMs: null });
      expect(statements.counts).toEqual({ expiry: 1, prune: 0 });
      expect(execute.mock.calls.some(([sql]) => /^(?:BEGIN|SAVEPOINT)\b/iu.test(sql))).toBe(false);
    } finally {
      admission.mockRestore();
      publication.mockRestore();
      execute.mockRestore();
      statements.restore();
    }
  });

  it("refreshes the host expiry cache after a worker write and prunes at its deadline", async () => {
    const baseDir = await createTempDir();
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
      const recordedAtMs = Date.now();
      const clock = createGatewaySchedulerClock(recordedAtMs);
      let scheduler = createTestGatewayScheduler(clock.clock);
      const dateNow = vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
      const onError = vi.fn();
      const readRetainedSetupIds = () =>
        openOpenClawStateDatabase()
          .db.prepare("SELECT setup_id FROM device_pair_setup_completions ORDER BY setup_id")
          .all();
      try {
        startDevicePairSetupMaintenance({ scheduler: scheduler.scope(), onError });
        await clock.wake();
        expect(clock.armedAtMs).toBeNull();
        const issued = await issueDevicePairSetupBootstrapToken({
          baseDir,
          profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        await verifyDeviceBootstrapToken({
          token: issued.token,
          deviceId: "device-123",
          publicKey: "public-key-123",
          role: "node",
          scopes: [],
          baseDir,
        });
        await consumeDeviceBootstrapTokenWithSetupCompletion({
          baseDir,
          token: issued.token,
          deviceId: "device-123",
          completedAtMs: recordedAtMs,
        });
        await expect(
          readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
        ).resolves.toMatchObject({
          setupId: issued.setupId,
          deviceId: "device-123",
          retainUntilMs: recordedAtMs + 20 * 60 * 1000,
        });
        await clock.wake();
        expect(clock.armedAtMs).toBe(recordedAtMs + 20 * 60 * 1000);

        await clock.advanceTo(recordedAtMs + 20 * 60 * 1000 - 1);
        expect(readRetainedSetupIds()).toEqual([{ setup_id: issued.setupId }]);
        await clock.advanceTo(recordedAtMs + 20 * 60 * 1000);
        // The status reader also prunes; inspect storage before invoking it.
        expect(readRetainedSetupIds()).toEqual([]);
        await expect(
          readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
        ).resolves.toBeNull();
        expect(onError).not.toHaveBeenCalled();

        await scheduler.stop();
        await closeOpenClawStateDatabaseAsync();
        const { db } = openOpenClawStateDatabase();
        db.prepare(
          "INSERT INTO device_pair_setup_completions (setup_id, device_id, access, completed_at_ms, delivery_state, retain_until_ms) VALUES ('restart-expired', 'device-123', 'node', 1, 'confirmed', ?)",
        ).run(recordedAtMs);
        await closeOpenClawStateDatabaseAsync();
        scheduler = createTestGatewayScheduler(clock.clock);
        startDevicePairSetupMaintenance({ scheduler: scheduler.scope(), onError });
        await clock.wake();
        expect(readRetainedSetupIds()).toEqual([]);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        dateNow.mockRestore();
        await scheduler.stop();
      }
    });
  });
});

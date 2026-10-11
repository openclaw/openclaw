import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  issueDevicePairSetupBootstrapToken,
  pruneExpiredDevicePairSetupCompletions,
  readDevicePairSetupCompletion,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { deviceBootstrapOperations } from "./device-bootstrap.worker-kernel.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device setup completion pruning", () => {
  it("keeps idle setup cleanup read-only and reuses its first expiry observation", async () => {
    const baseDir = await createTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: baseDir };
    const database = openOpenClawStateDatabase({ env });
    const statements = trackSqliteStatementExecutions(database.db, ["expiry", "prune"], (sql) =>
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
      expect(prune(1_000)).toBe(0);
      expect(prune(1_001)).toBe(0);
      expect(statements.counts).toEqual({ expiry: 1, prune: 0 });
      expect(execute.mock.calls.some(([sql]) => /^(?:BEGIN|SAVEPOINT)\b/iu.test(sql))).toBe(false);
    } finally {
      admission.mockRestore();
      publication.mockRestore();
      execute.mockRestore();
      statements.restore();
    }
  });

  it("prunes newly retained setup outcomes at their deadline after an idle pass", async () => {
    const baseDir = await createTempDir();
    vi.useFakeTimers();
    try {
      const recordedAtMs = Date.now();
      await expect(
        pruneExpiredDevicePairSetupCompletions({ baseDir, nowMs: recordedAtMs }),
      ).resolves.toBe(0);
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
        pruneExpiredDevicePairSetupCompletions({
          baseDir,
          nowMs: recordedAtMs + 20 * 60 * 1000 - 1,
        }),
      ).resolves.toBe(0);

      await expect(
        pruneExpiredDevicePairSetupCompletions({
          baseDir,
          nowMs: recordedAtMs + 20 * 60 * 1000,
        }),
      ).resolves.toBe(1);
      await expect(
        readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
      ).resolves.toBeNull();

      await expect(
        pruneExpiredDevicePairSetupCompletions({ baseDir, nowMs: recordedAtMs }),
      ).resolves.toBe(0);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
      });
      db.prepare(
        "INSERT INTO device_pair_setup_completions (setup_id, device_id, access, completed_at_ms, delivery_state, retain_until_ms) VALUES ('foreign-expired', 'device-123', 'node', 1, 'confirmed', ?)",
      ).run(recordedAtMs);
      await expect(
        pruneExpiredDevicePairSetupCompletions({ baseDir, nowMs: recordedAtMs }),
      ).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

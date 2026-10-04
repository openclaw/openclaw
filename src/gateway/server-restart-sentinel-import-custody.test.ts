import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as stateOwner from "../infra/gateway-state-owner.js";
import { readRestartSentinel, writeRestartSentinel } from "../infra/restart-sentinel.js";
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../infra/state-migrations.receipts.js";
import { importLegacyUpdateRestartSentinel } from "../infra/state-migrations.restart-sentinel-runtime.js";
import * as legacySource from "../infra/state-migrations.source-snapshot.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const gatewayLocks: Array<{ release: () => Promise<void> }> = [];
let envSnapshot: ReturnType<typeof captureEnv>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const lock of gatewayLocks.splice(0)) {
      await lock.release();
    }
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
    resetConfigRuntimeState();
    await closeOpenClawStateDatabaseAsync();
    resetGatewayWorkAdmission();
    resetSystemEventsForTest();
    vi.restoreAllMocks();
    envSnapshot.restore();
    cleanup();
  });
});

beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_SUPERVISOR_MODE"]);
  setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "");
  vi.clearAllMocks();
});

it.each(["absent", "maintenance"] as const)(
  "refuses legacy notice import with an %s Gateway owner",
  async (ownerKind) => {
    const stateDir = tempDirs.make("openclaw-restart-import-gateway-owner-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const retained = await writeRestartSentinel(
      { kind: "restart", status: "ok", ts: 123, message: "Retained canonical notice" },
      env,
    );
    const context = captureDeliveryQueueStateContext();
    const sourcePath = path.join(stateDir, "restart-sentinel.json");
    const source = JSON.stringify({
      version: 1,
      payload: { kind: "update", status: "ok", ts: 124, stats: { mode: "npm" } },
    });
    await fs.writeFile(sourcePath, source);
    const owner =
      ownerKind === "maintenance"
        ? stateOwner.acquireGatewayStateOwner({
            databasePath: context.workerContext.admission.databasePath,
          })
        : undefined;
    try {
      await expect(
        importLegacyUpdateRestartSentinel({
          context: context.workerContext,
          shouldRun: () => true,
        }),
      ).rejects.toThrow("no longer owns this Gateway generation");
    } finally {
      owner?.release();
    }
    expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
    expect(await readRestartSentinel(env)).toEqual(retained);
    expect(
      readLegacyMigrationReceipt(
        resolveLegacyMigrationSourceKey("restart-sentinel-json", sourcePath),
        env,
      ),
    ).toBeNull();
  },
);

it("joins a paused import without publishing after canonical database close revokes admission", async () => {
  const stateDir = tempDirs.make("openclaw-restart-import-close-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  const lock = await acquireGatewayLock({ env, allowInTests: true });
  if (!lock) {
    throw new Error("Expected Gateway lifecycle ownership");
  }
  gatewayLocks.push(lock);
  const retained = await writeRestartSentinel(
    { kind: "restart", status: "ok", ts: 123, message: "Retained canonical notice" },
    env,
  );
  const context = captureDeliveryQueueStateContext();
  const sourcePath = path.join(stateDir, "restart-sentinel.json");
  const source = JSON.stringify({
    version: 1,
    payload: { kind: "update", status: "ok", ts: 124, stats: { mode: "npm" } },
  });
  await fs.writeFile(sourcePath, source);
  const readStarted = createDeferred();
  const releaseRead = createDeferred();
  const readSource = legacySource.readLegacyMigrationSourceSnapshot;
  vi.spyOn(legacySource, "readLegacyMigrationSourceSnapshot").mockImplementationOnce(
    async (options) => {
      const snapshot = await readSource(options);
      readStarted.resolve();
      await releaseRead.promise;
      return snapshot;
    },
  );
  let custody: ReturnType<typeof stateOwner.tryBorrowGatewayStateOwner> | undefined;
  const acquire = stateOwner.tryBorrowGatewayStateOwner;
  vi.spyOn(stateOwner, "tryBorrowGatewayStateOwner").mockImplementation((options) => {
    custody = acquire(options);
    return custody;
  });
  const importing = importLegacyUpdateRestartSentinel({
    context: context.workerContext,
    shouldRun: () => true,
  });
  const importSettled = importing.then(
    () => "settled" as const,
    () => "settled" as const,
  );
  let closing: Promise<void> | undefined;
  let closeSettled = false;
  try {
    expect(
      await Promise.race([readStarted.promise.then(() => "held" as const), importSettled]),
    ).toBe("held");
    context.workerContext.admission.assertCurrent();
    expect(custody?.assertCurrent).not.toThrow();
    closing = closeOpenClawStateDatabaseAsync();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    expect(context.workerContext.admission.assertCurrent).toThrow(/read admission is closed/);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(closeSettled).toBe(false);
    expect(custody?.assertCurrent).not.toThrow();
    releaseRead.resolve();
    const result = await importing;
    await closing;
    expect(result.changes).toEqual([]);
    expect(result.importedRevision).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("read admission is closed")]);
    expect(custody?.assertCurrent).toThrow(/ownership is no longer current/);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
    await expect(fs.stat(`${sourcePath}.doctor-importing`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readRestartSentinel(env)).toEqual(retained);
    expect(
      readLegacyMigrationReceipt(
        resolveLegacyMigrationSourceKey("restart-sentinel-json", sourcePath),
        env,
      ),
    ).toBeNull();
  } finally {
    releaseRead.resolve();
    await Promise.allSettled([importing, ...(closing ? [closing] : [])]);
  }
});

it("retains failed import cleanup until canonical database close retries its owner", async () => {
  const stateDir = tempDirs.make("openclaw-restart-import-cleanup-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  const lock = await acquireGatewayLock({ env, allowInTests: true });
  if (!lock) {
    throw new Error("Expected Gateway lifecycle ownership");
  }
  gatewayLocks.push(lock);
  const context = captureDeliveryQueueStateContext();
  await fs.writeFile(
    path.join(stateDir, "restart-sentinel.json"),
    JSON.stringify({
      version: 1,
      payload: { kind: "update", status: "ok", ts: 124, stats: { mode: "npm" } },
    }),
  );
  const failure = new Error("import resource cleanup failed once");
  const closeResource = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  let scope: OpenClawDatabaseMaintenanceScope | undefined;
  let custody: ReturnType<typeof stateOwner.tryBorrowGatewayStateOwner> | undefined;
  const acquire = stateOwner.tryBorrowGatewayStateOwner;
  vi.spyOn(stateOwner, "tryBorrowGatewayStateOwner").mockImplementation((params) => {
    custody = acquire(params);
    return custody;
  });
  const readSource = legacySource.readLegacyMigrationSourceSnapshot;
  vi.spyOn(legacySource, "readLegacyMigrationSourceSnapshot").mockImplementationOnce(
    async (params) => {
      const snapshot = await readSource(params);
      scope = getOpenClawDatabaseMaintenanceScope();
      if (!scope) {
        throw new Error("Expected importer maintenance scope");
      }
      scope.own({}, "shared-resources", closeResource);
      return snapshot;
    },
  );
  try {
    await expect(
      importLegacyUpdateRestartSentinel({ context: context.workerContext, shouldRun: () => true }),
    ).rejects.toBe(failure);
    expect(closeResource).toHaveBeenCalledOnce();
    expect(custody?.assertCurrent).not.toThrow();
    await lock.release();
    expect(
      stateOwner.tryAcquireGatewayStateOwner(context.workerContext.admission.databasePath),
    ).toBeNull();
    expect(custody?.assertCurrent).not.toThrow();
    await closeOpenClawStateDatabaseAsync();
    expect(closeResource).toHaveBeenCalledTimes(2);
    expect(custody?.assertCurrent).toThrow(/ownership is no longer current/);
    const successor = stateOwner.tryAcquireGatewayStateOwner(
      context.workerContext.admission.databasePath,
    );
    if (!successor) {
      throw new Error("Expected settled import custody to admit a successor");
    }
    try {
      expect(custody?.assertCurrent).toThrow(/ownership is no longer current/);
    } finally {
      successor.release();
    }
  } finally {
    await scope?.close();
    custody?.release();
  }
});

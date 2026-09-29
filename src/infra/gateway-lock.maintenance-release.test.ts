import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

async function withMaintenanceLock(
  run: (
    lock: NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>,
    contender: () => ReturnType<typeof acquireGatewayLock>,
  ) => Promise<void>,
) {
  await withTempDir("openclaw-maintenance-release-", async (root) => {
    const options = {
      allowInTests: true,
      timeoutMs: 0,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      },
    };
    const lock = await acquireGatewayLock({ ...options, role: "sqlite-maintenance" });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    try {
      await run(lock, () => acquireGatewayLock(options));
    } finally {
      await lock.release();
    }
  });
}

describe("maintenance release", () => {
  it("keeps startup excluded while concurrent releases join resource drainage", async () => {
    await withMaintenanceLock(async (lock, contender) => {
      const started = createDeferred();
      const drained = createDeferred();
      const close = vi.fn(async () => {
        started.resolve();
        await drained.promise;
      });
      lock.run(() => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        expect(scope?.ownsSchemaMaintenance).toBe(true);
        scope?.own({}, "shared-resources", close);
      });
      const releases = [lock.release(), lock.releaseInTree(), lock.release()];
      try {
        await started.promise;
        await expect(contender()).rejects.toBeInstanceOf(GatewayLockError);
        await fs.access(lock.lockPath);
        await fs.access(lock.stateLockPath);
      } finally {
        drained.resolve();
        await Promise.all(releases);
      }
      expect(close).toHaveBeenCalledTimes(1);
      await Promise.all([lock.release(), lock.releaseInTree()]);
      expect(close).toHaveBeenCalledTimes(1);
      await expect(fs.access(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(lock.stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await (await contender())?.release();
    });
  });

  it("retains the process owner after failed drainage and retries only unsettled resources", async () => {
    await withMaintenanceLock(async (lock, contender) => {
      const failure = new Error("Controlled cleanup failure");
      const closeAgent = vi.fn();
      const closeShared = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
      lock.run(() => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        scope?.own({}, "agent-resources", closeAgent);
        scope?.own({}, "shared-resources", closeShared);
      });
      const results = await Promise.allSettled([lock.release(), lock.release()]);
      expect(results).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      await expect(contender()).rejects.toBeInstanceOf(GatewayLockError);
      await fs.access(lock.lockPath);
      await fs.access(lock.stateLockPath);
      await lock.release();
      expect(closeAgent).toHaveBeenCalledTimes(1);
      expect(closeShared).toHaveBeenCalledTimes(2);
      await (await contender())?.release();
    });
  });
});

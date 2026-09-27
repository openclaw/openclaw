import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

const owners = vi.hoisted(() => ({
  closeAgentResource: vi.fn<() => Promise<void>>(),
  closeSharedResource: vi.fn<() => Promise<void>>(),
  releaseConfig: vi.fn<() => Promise<void>>(),
  releaseState: vi.fn<() => Promise<void>>(),
  releaseGateway: vi.fn<() => void>(),
}));

vi.mock("./file-lock-manager.js", () => ({
  createFileLockManager: () => ({
    acquire: async (lockPath: string) => ({
      lockPath,
      release: lockPath.endsWith("gateway.state.lock") ? owners.releaseState : owners.releaseConfig,
    }),
  }),
}));
vi.mock("./sqlite-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-coordinator.js")>()),
  tryAcquireExclusiveSqliteCoordinator: () => ({ release() {} }),
}));
vi.mock("./state-database-coordinator.js", async (importOriginal) => {
  const acquireCoordinator = () => {
    let closed = false;
    return {
      createSchemaFenceDelegate: () => undefined,
      release() {
        if (!closed) {
          closed = true;
          owners.releaseGateway();
        }
      },
    };
  };
  return {
    ...(await importOriginal<typeof import("./state-database-coordinator.js")>()),
    acquireGatewayLifecycleCoordinator: acquireCoordinator,
    acquireGatewayMaintenanceCoordinator: acquireCoordinator,
  };
});

async function withMaintenanceLock(
  run: (lock: NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>) => Promise<void>,
) {
  await withTempDir("openclaw-maintenance-release-", async (root) => {
    const stateDir = await fs.realpath(root);
    const lock = await acquireGatewayLock({
      allowInTests: true,
      role: "sqlite-maintenance",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
    });
    if (!lock) {
      throw new Error("Expected maintenance lock");
    }
    try {
      lock.run(() => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        if (!scope) {
          throw new Error("Expected maintenance resource scope");
        }
        scope.own({}, "agent-resources", owners.closeAgentResource);
        scope.own({}, "shared-resources", owners.closeSharedResource);
      });
      await run(lock);
    } finally {
      await lock.release();
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  owners.closeAgentResource.mockResolvedValue();
  owners.closeSharedResource.mockResolvedValue();
  owners.releaseConfig.mockResolvedValue();
  owners.releaseState.mockResolvedValue();
});

describe("maintenance release", () => {
  it("joins concurrent release calls and leaves later resources alone after completion", async () => {
    const started = createDeferred();
    const drained = createDeferred();
    owners.closeSharedResource.mockImplementation(() => {
      started.resolve();
      return drained.promise;
    });
    await withMaintenanceLock(async (lock) => {
      const releases = [lock.release(), lock.releaseInTree(), lock.release()];
      try {
        const first = await Promise.race([
          started.promise.then(() => "draining"),
          Promise.all(releases).then(() => "released"),
        ]);
        expect(first).toBe("draining");
        expect(owners.closeAgentResource).toHaveBeenCalledTimes(1);
        expect(owners.closeSharedResource).toHaveBeenCalledTimes(1);
        expect(owners.releaseConfig).not.toHaveBeenCalled();
        expect(owners.releaseState).not.toHaveBeenCalled();
        expect(owners.releaseGateway).not.toHaveBeenCalled();
      } finally {
        drained.resolve();
        await Promise.all(releases);
      }
      expect(owners.releaseConfig).toHaveBeenCalledTimes(1);
      expect(owners.releaseState).toHaveBeenCalledTimes(1);
      expect(owners.releaseGateway).toHaveBeenCalledTimes(1);
      owners.closeAgentResource.mockRejectedValue(
        new Error("Later agent resources must be untouched"),
      );
      owners.closeSharedResource.mockRejectedValue(
        new Error("Later shared resources must be untouched"),
      );
      await Promise.all([lock.release(), lock.releaseInTree(), lock.release()]);
      expect(owners.closeAgentResource).toHaveBeenCalledTimes(1);
      expect(owners.closeSharedResource).toHaveBeenCalledTimes(1);
      expect(owners.releaseGateway).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["shared drain", "config cleanup"] as const)(
    "retains custody after failed %s and retries only unfinished cleanup",
    async (phase) => {
      const failedOwner =
        phase === "shared drain" ? owners.closeSharedResource : owners.releaseConfig;
      const failure = new Error("Controlled JavaScript cleanup failure");
      failedOwner.mockRejectedValueOnce(failure);
      await withMaintenanceLock(async (lock) => {
        const results = await Promise.allSettled([lock.release(), lock.release()]);
        const expectedFailure =
          phase === "shared drain"
            ? failure
            : new GatewayLockError(`failed to release gateway lock at ${lock.lockPath}`, failure);
        expect(results).toEqual([
          { status: "rejected", reason: expectedFailure },
          { status: "rejected", reason: expectedFailure },
        ]);
        expect(owners.releaseState).not.toHaveBeenCalled();
        expect(owners.releaseGateway).not.toHaveBeenCalled();
        await lock.release();
        const sharedCloseCount = phase === "shared drain" ? 2 : 1;
        expect(owners.closeAgentResource).toHaveBeenCalledTimes(1);
        expect(owners.closeSharedResource).toHaveBeenCalledTimes(sharedCloseCount);
        expect(owners.releaseConfig).toHaveBeenCalledTimes(phase === "shared drain" ? 1 : 2);
        expect(owners.releaseState).toHaveBeenCalledTimes(1);
        expect(owners.releaseGateway).toHaveBeenCalledTimes(1);
        await lock.release();
        expect(owners.closeSharedResource).toHaveBeenCalledTimes(sharedCloseCount);
      });
    },
  );
});

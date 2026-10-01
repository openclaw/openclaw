import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GatewayStartupCleanupError } from "./server-shutdown.js";
import { startGatewayServer } from "./server.js";

type GatewayLock = NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;
const runtime = vi.hoisted(() => ({
  close: async () => {},
  startupError: undefined as Error | undefined,
  locks: [] as GatewayLock[],
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-lock.js")>();
  return {
    ...actual,
    async acquireGatewayLock(options: Parameters<typeof actual.acquireGatewayLock>[0]) {
      const lock = await actual.acquireGatewayLock({
        ...options,
        allowInTests: true,
        timeoutMs: 0,
      });
      if (lock) {
        runtime.locks.push(lock);
      }
      return lock;
    },
  };
});
vi.mock("../process/spawn-broker/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/spawn-broker/context.js")>()),
  startGatewaySpawnBroker: async () => undefined,
}));
vi.mock("../state/openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: () => ({ ready: Promise.resolve(), stop: async () => {} }),
}));
vi.mock("./server-start.js", () => ({
  startGatewayServerCore: async () => {
    if (runtime.startupError) {
      throw runtime.startupError;
    }
    return {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: () => runtime.close(),
    };
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const root = tempDirs.make("openclaw-server-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  runtime.close = async () => {};
  runtime.startupError = undefined;
});
afterEach(async () => {
  for (const lock of runtime.locks.splice(0)) {
    await lock.release();
  }
  vi.unstubAllEnvs();
});

it("refuses a second direct Gateway until the first finishes closing", async () => {
  const first = await startGatewayServer(18701);
  const closed = createDeferredCore();
  const closing = createDeferredCore();
  runtime.close = async () => {
    closing.resolve();
    await closed.promise;
  };
  const stop = first.close();
  await closing.promise;
  try {
    await expect(startGatewayServer(18702)).rejects.toThrow("gateway state ownership");
    expect(await readActiveGatewayLockIdentity()).toMatchObject({ pid: process.pid, port: 18701 });
  } finally {
    closed.resolve();
    await stop;
  }
  runtime.close = async () => {};
  const successor = await startGatewayServer(18702);
  await successor.close();
  expect(await readActiveGatewayLockIdentity()).toBeUndefined();
});

it("releases direct ownership after a clean startup failure", async () => {
  runtime.startupError = new Error("startup failed");
  await expect(startGatewayServer(18701)).rejects.toBe(runtime.startupError);
  runtime.startupError = undefined;
  const successor = await startGatewayServer(18702);
  await successor.close();
  expect(await readActiveGatewayLockIdentity()).toBeUndefined();
});

it("keeps the run loop's owner across server generations and rejects its retired capability", async () => {
  const lock = await acquireGatewayLock({ port: 18701 });
  expect(lock).not.toBeNull();
  const first = await startGatewayServer(18701, { gatewayStateOwner: lock! });
  await first.close();
  await expect(startGatewayServer(18702)).rejects.toThrow("gateway state ownership");
  const restarted = await startGatewayServer(18701, { gatewayStateOwner: lock! });
  await restarted.close();
  await lock!.release();
  await expect(startGatewayServer(18701, { gatewayStateOwner: lock! })).rejects.toThrow(
    "no longer current",
  );
});

it.each(["startup", "shutdown"] as const)(
  "retains direct ownership when %s cleanup has not completed",
  async (phase) => {
    const failure = new GatewayStartupCleanupError(new Error("startup"), new Error("cleanup"));
    if (phase === "startup") {
      runtime.startupError = failure;
      await expect(startGatewayServer(18701)).rejects.toBe(failure);
      runtime.startupError = undefined;
    } else {
      const first = await startGatewayServer(18701);
      runtime.close = async () => {
        throw failure;
      };
      await expect(first.close()).rejects.toBe(failure);
      runtime.close = async () => {};
    }
    await expect(startGatewayServer(18702)).rejects.toThrow("gateway state ownership");
  },
);

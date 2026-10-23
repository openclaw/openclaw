import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  listNodePairing,
  releaseNodePairingCleanupClaim,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createNodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-reapproval-" });
const limit = { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 };
const nodeInput = (surface = "screen") => ({
  nodeId: "node-1",
  platform: "darwin",
  caps: ["camera", surface],
});

async function pairedFixture(
  name: string,
  config?: Parameters<typeof createNodeReapprovalCoordinator>[0],
  scheduler = createTestGatewayScheduler(),
) {
  const baseDir = await tempDirs.make(name);
  await setupPairedNode(baseDir);
  const coordinator = createNodeReapprovalCoordinator(config, { scheduler });
  const request = (surface = "screen") =>
    coordinator.request({ input: nodeInput(surface), baseDir });
  return { baseDir, coordinator, request };
}

async function setupPairedNode(baseDir: string): Promise<void> {
  // Node surfaces attach to paired devices, so device pairing comes first.
  const devicePairing = await requestDevicePairing(
    {
      deviceId: "node-1",
      publicKey: "pk-node-1",
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    baseDir,
  );
  await approveDevicePairing(devicePairing.request.requestId, { callerScopes: [] }, baseDir);
  const request = await requestNodePairing({ ...nodeInput(), caps: ["camera"] }, baseDir);
  await approveNodePairing(
    request.request.requestId,
    { callerScopes: ["operator.pairing"] },
    baseDir,
  );
}

async function expectPending(baseDir: string, expected: object) {
  expect((await listNodePairing(baseDir)).pending).toEqual([expect.objectContaining(expected)]);
}

describe("node reapproval coordinator", () => {
  beforeAll(() => tempDirs.setup());

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await tempDirs.cleanup();
  });

  test("retains changed-surface quota and free pending reuse across policy updates", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { baseDir, coordinator, request } = await pairedFixture(
      "reuse",
      { ...limit, exemptLoopback: true },
      scheduler,
    );
    const pending = await requestNodePairing(nodeInput(), baseDir);
    const reconnect = async (surface = "screen") => {
      const { cleanupClaim } = await beginNodePairingConnect("node-1", baseDir);
      const result = await coordinator.request({
        input: nodeInput(surface),
        cleanupClaim,
        baseDir,
      });
      if (cleanupClaim) {
        await releaseNodePairingCleanupClaim(cleanupClaim);
      }
      return result;
    };
    await expect(reconnect()).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    await expect(reconnect("microphone")).resolves.toMatchObject({
      request: { caps: ["camera", "microphone"] },
      created: true,
    });

    coordinator.updateConfig({ ...limit, maxAttempts: 1, exemptLoopback: true });
    await expect(request("location")).resolves.toBeNull();
    await expectPending(baseDir, { caps: ["camera", "microphone"] });
    await expect(request("microphone")).resolves.toMatchObject({
      request: { caps: ["camera", "microphone"] },
      created: false,
    });

    await clock.advanceBy(60_000);
    await expect(request("location")).resolves.toMatchObject({
      request: { caps: ["camera", "location"] },
      created: true,
    });

    coordinator.dispose();
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  test("stops accepting work after disposal", async () => {
    const { baseDir, coordinator, request } = await pairedFixture("dispose");
    coordinator.dispose();

    await expect(request()).resolves.toBeNull();
    expect((await listNodePairing(baseDir)).pending).toEqual([]);
  });

  test.each(["location", "screen"])(
    "supersedes queued work with the latest %s declaration, reusing active work if equal",
    async (surface) => {
      const { baseDir, coordinator, request } = await pairedFixture(`latest-${surface}`, limit);
      const active = request();
      const stale = request("microphone");
      const latest = request(surface);
      await expect(active).resolves.toMatchObject({ request: { caps: ["camera", "screen"] } });
      await expect(stale).resolves.toBeNull();
      await expect(latest).resolves.toMatchObject({
        request: { caps: ["camera", surface] },
        ...(surface === "screen" ? { created: false } : {}),
      });
      await expectPending(baseDir, { caps: ["camera", surface] });
      coordinator.dispose();
    },
  );

  test("retains the newest cleanup claim across equivalent reconnects", async () => {
    const { baseDir, coordinator } = await pairedFixture("cleanup-generation");
    const pending = await requestNodePairing(nodeInput(), baseDir);
    const first = await beginNodePairingConnect("node-1", baseDir);
    const staleCleanup = await beginNodePairingConnect("node-1", baseDir);
    const latest = await beginNodePairingConnect("node-1", baseDir);
    expect(first.cleanupClaim).toBeDefined();
    expect(staleCleanup.cleanupClaim).toBeDefined();
    expect(latest.cleanupClaim).toBeDefined();
    const reuse = (cleanupClaim: typeof first.cleanupClaim) =>
      coordinator.request({ input: nodeInput(), cleanupClaim, baseDir });
    const firstReuse = reuse(first.cleanupClaim);
    const latestReuse = reuse(latest.cleanupClaim);
    const cleanup = coordinator.finalizeCleanup(staleCleanup.cleanupClaim!);

    await expect(firstReuse).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
    });
    await expect(latestReuse).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    await expect(cleanup).resolves.toEqual([]);
    await expectPending(baseDir, { requestId: pending.request.requestId });

    coordinator.dispose();
  });
});

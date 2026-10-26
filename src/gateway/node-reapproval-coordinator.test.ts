import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  approveNodePairing,
  beginNodePairingConnect,
  listNodePairing,
  releaseNodePairingCleanupClaim,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { seedNodeDevice } from "../infra/device-pairing-node.test-support.js";
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
  await seedNodeDevice(baseDir, "node-1");
  const pairing = await requestNodePairing({ ...nodeInput(), caps: ["camera"] }, baseDir);
  await approveNodePairing(
    pairing.request.requestId,
    { callerScopes: ["operator.pairing"] },
    baseDir,
  );
  const coordinator = createNodeReapprovalCoordinator(config, { scheduler });
  const request = (surface = "screen") =>
    coordinator.request({ input: nodeInput(surface), baseDir });
  return { baseDir, coordinator, request };
}

async function expectPending(baseDir: string, expected: object) {
  expect((await listNodePairing(baseDir)).pending).toEqual([expect.objectContaining(expected)]);
}

function expectRequest(
  result: ReturnType<ReturnType<typeof createNodeReapprovalCoordinator>["request"]>,
  request: object,
  created?: boolean,
) {
  return expect(result).resolves.toMatchObject({
    request,
    ...(created === undefined ? {} : { created }),
  });
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
    await expectRequest(reconnect(), { requestId: pending.request.requestId }, false);
    await expectRequest(reconnect("microphone"), { caps: ["camera", "microphone"] }, true);

    coordinator.updateConfig({ ...limit, maxAttempts: 1, exemptLoopback: true });
    await expect(request("location")).resolves.toBeNull();
    await expectPending(baseDir, { caps: ["camera", "microphone"] });
    await expectRequest(request("microphone"), { caps: ["camera", "microphone"] }, false);

    await clock.advanceBy(60_000);
    await expectRequest(request("location"), { caps: ["camera", "location"] }, true);

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
      await expectRequest(active, { caps: ["camera", "screen"] });
      await expect(stale).resolves.toBeNull();
      await expectRequest(
        latest,
        { caps: ["camera", surface] },
        surface === "screen" ? false : undefined,
      );
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

    await expectRequest(firstReuse, { requestId: pending.request.requestId });
    await expectRequest(latestReuse, { requestId: pending.request.requestId }, false);
    await expect(cleanup).resolves.toEqual([]);
    await expectPending(baseDir, { requestId: pending.request.requestId });

    coordinator.dispose();
  });
});

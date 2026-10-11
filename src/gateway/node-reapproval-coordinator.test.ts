// Covers paired-node reapproval reuse and changed-surface write limits.
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
  const request = await requestNodePairing(
    {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera"],
    },
    baseDir,
  );
  await approveNodePairing(
    request.request.requestId,
    { callerScopes: ["operator.pairing"] },
    baseDir,
  );
}

describe("node reapproval coordinator", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await tempDirs.cleanup();
  });

  test("retains changed-surface quota and free pending reuse across policy updates", async () => {
    const baseDir = await tempDirs.make("reuse");
    await setupPairedNode(baseDir);
    const pending = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    );
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const coordinator = createNodeReapprovalCoordinator(
      {
        maxAttempts: 2,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: true,
      },
      { scheduler },
    );

    const matchingConnect = await beginNodePairingConnect("node-1", baseDir);
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "screen"],
        },
        cleanupClaim: matchingConnect.cleanupClaim,
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    if (matchingConnect.cleanupClaim) {
      await releaseNodePairingCleanupClaim(matchingConnect.cleanupClaim);
    }

    const changedConnect = await beginNodePairingConnect("node-1", baseDir);
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "microphone"],
        },
        cleanupClaim: changedConnect.cleanupClaim,
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { caps: ["camera", "microphone"] },
      created: true,
    });
    if (changedConnect.cleanupClaim) {
      await releaseNodePairingCleanupClaim(changedConnect.cleanupClaim);
    }

    coordinator.updateConfig({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: true,
    });
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "location"],
        },
        baseDir,
      }),
    ).resolves.toBeNull();
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "microphone"] }),
    ]);
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "microphone"],
        },
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { caps: ["camera", "microphone"] },
      created: false,
    });

    await clock.advanceBy(60_000);
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "location"],
        },
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { caps: ["camera", "location"] },
      created: true,
    });

    coordinator.dispose();
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  test("stops accepting work after disposal", async () => {
    const baseDir = await tempDirs.make("dispose");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator(undefined, {
      scheduler: createTestGatewayScheduler(),
    });
    coordinator.dispose();

    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "screen"],
        },
        baseDir,
      }),
    ).resolves.toBeNull();
    expect((await listNodePairing(baseDir)).pending).toEqual([]);
  });

  test("keeps only the latest request waiting behind active work", async () => {
    const baseDir = await tempDirs.make("latest");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator(
      {
        maxAttempts: 2,
        windowMs: 60_000,
        lockoutMs: 60_000,
      },
      { scheduler: createTestGatewayScheduler() },
    );

    const active = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    });
    const superseded = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "microphone"],
      },
      baseDir,
    });
    const latest = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "location"],
      },
      baseDir,
    });

    await expect(active).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
    });
    await expect(superseded).resolves.toBeNull();
    await expect(latest).resolves.toMatchObject({
      request: { caps: ["camera", "location"] },
    });
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "location"] }),
    ]);

    coordinator.dispose();
  });

  test("cancels queued work when the latest declaration matches active work", async () => {
    const baseDir = await tempDirs.make("active-latest");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator(
      {
        maxAttempts: 2,
        windowMs: 60_000,
        lockoutMs: 60_000,
      },
      { scheduler: createTestGatewayScheduler() },
    );
    const activeInput = {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera", "screen"],
    };

    const active = coordinator.request({ input: activeInput, baseDir });
    const stale = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "microphone"],
      },
      baseDir,
    });
    const latest = coordinator.request({ input: activeInput, baseDir });

    await expect(active).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
    });
    await expect(stale).resolves.toBeNull();
    await expect(latest).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
      created: false,
    });
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "screen"] }),
    ]);

    coordinator.dispose();
  });

  test("retains the newest cleanup claim across equivalent reconnects", async () => {
    const baseDir = await tempDirs.make("cleanup-generation");
    await setupPairedNode(baseDir);
    const pending = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    );
    const first = await beginNodePairingConnect("node-1", baseDir);
    const staleCleanup = await beginNodePairingConnect("node-1", baseDir);
    const latest = await beginNodePairingConnect("node-1", baseDir);
    expect(first.cleanupClaim).toBeDefined();
    expect(staleCleanup.cleanupClaim).toBeDefined();
    expect(latest.cleanupClaim).toBeDefined();
    const coordinator = createNodeReapprovalCoordinator(undefined, {
      scheduler: createTestGatewayScheduler(),
    });
    const input = {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera", "screen"],
    };

    const firstReuse = coordinator.request({
      input,
      cleanupClaim: first.cleanupClaim,
      baseDir,
    });
    const latestReuse = coordinator.request({
      input,
      cleanupClaim: latest.cleanupClaim,
      baseDir,
    });
    const cleanup = coordinator.finalizeCleanup(staleCleanup.cleanupClaim!);

    await expect(firstReuse).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
    });
    await expect(latestReuse).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    await expect(cleanup).resolves.toEqual([]);
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ requestId: pending.request.requestId }),
    ]);

    coordinator.dispose();
  });
});

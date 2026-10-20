import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import {
  listDevicePairing,
  removePairedDeviceRole,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { loadApnsRegistration, registerApnsRegistration } from "../infra/push-apns.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { pruneSupersededSilentPairingsAfterApproval } from "./device-pairing-prune.js";
import {
  acceptGatewayDeviceSourceAuthority,
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "./node-pending-work.js";
import { enqueuePendingNodeAction, listPendingNodeActions } from "./node-runtime-state.js";
import {
  captureNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
} from "./node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "./node-wake-state.test-support.js";
import { bindDeviceWorkerReconciliation } from "./worker-environments/device-provider.js";

const pairingStateDirs: string[] = [];
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-pairing-prune-" });

type PruneContext = Parameters<typeof pruneSupersededSilentPairingsAfterApproval>[0]["context"];

function createPruneContext(params?: {
  connectedDeviceIds?: string[];
  workerEnvironmentIds?: Record<string, readonly string[]>;
}) {
  const order: string[] = [];
  const connectedDeviceIds = params?.connectedDeviceIds ?? [];
  const workerEnvironmentService = {} as NonNullable<PruneContext["workerEnvironmentService"]>;
  bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
    order.push(`worker:${deviceId}`);
    return params?.workerEnvironmentIds?.[deviceId] ?? [];
  });
  const workerPlacementDispatchService = {
    reconcileActive: async (id: string) => void order.push(`placement:${id}`),
  } as NonNullable<PruneContext["workerPlacementDispatchService"]>;
  const invalidate = vi.fn<(id: string) => void>();
  const context = {
    broadcast: vi.fn<PruneContext["broadcast"]>(),
    logGateway: {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
    },
    hasConnectedClientsForDevice: (id: string) => connectedDeviceIds.includes(id),
    invalidateClientsForDevice: invalidate,
    disconnectClientsForDevice: vi.fn((id: string) => void order.push(`disconnect:${id}`)),
    workerEnvironmentService,
    workerPlacementDispatchService,
    nodeRegistry: { updateSurface: vi.fn((_id: string) => null) },
  } satisfies PruneContext;
  invalidate.mockImplementation((id) => {
    order.push(`invalidate:${id}`);
    invalidateGatewayDeviceRevocation(context, id);
  });
  return Object.assign(context, { order, connectedDeviceIds });
}
async function pairSilentDevice(baseDir: string, deviceId: string, roles = ["operator"]) {
  const node = roles[0] === "node";
  const request = await requestDevicePairing(
    {
      deviceId,
      publicKey: `pk-${deviceId}`,
      clientId: node ? "node-host" : "cli",
      clientMode: node ? "node" : "cli",
      displayName: node ? "megaclaw" : undefined,
      role: roles[0],
      roles,
      scopes: [],
    },
    baseDir,
  );
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: [], approvedVia: "silent" },
    baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${deviceId}`);
  }
  return approved.device;
}

async function makeStateDir() {
  const baseDir = await suiteRootTracker.make("case");
  pairingStateDirs.push(baseDir);
  return baseDir;
}
const registerApns = (baseDir: string, nodeId: string) =>
  registerApnsRegistration({
    nodeId,
    baseDir,
    transport: "direct",
    token: "ABCD1234ABCD1234ABCD1234ABCD1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
  });
const prune = (
  context: ReturnType<typeof createPruneContext>,
  baseDir: string,
  deviceId = "cli-anchor",
) =>
  pruneSupersededSilentPairingsAfterApproval({
    deviceId,
    context,
    connectedDeviceIds: context.connectedDeviceIds,
    baseDir,
    nowMs: Date.now() + 120_000,
  });

describe("pruneSupersededSilentPairingsAfterApproval", () => {
  beforeAll(() => suiteRootTracker.setup());

  afterAll(async () => {
    for (const stateDir of pairingStateDirs) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
      );
    }
    await suiteRootTracker.cleanup();
  });

  afterEach(resetNodeWakeStateForTest);

  test("revokes the full batch before worker cleanup can wait or fail", async () => {
    const baseDir = await makeStateDir();
    for (const deviceId of ["cli-first", "cli-second", "cli-anchor"]) {
      await pairSilentDevice(baseDir, deviceId);
    }
    const context = createPruneContext();
    let connected = true;
    const request = captureGatewayDeviceRevocation(
      context,
      { deviceId: "cli-second", role: "operator" },
      () => connected,
      undefined,
      { isCurrent: () => true, subscribe: () => () => {} },
    );
    expect(acceptGatewayDeviceSourceAuthority(request.isCurrent)).toBe(true);
    const releaseRun = retainGatewayDeviceRevocation(request.isCurrent);
    request.release();
    connected = false;
    expect(request.isCurrent()).toBe(true);

    const entered = createDeferredCore();
    const cleanup = createDeferredCore();
    bindDeviceWorkerReconciliation(
      expectDefined(context.workerEnvironmentService, "worker environment service"),
      async () => {
        entered.resolve();
        await cleanup.promise;
        return [];
      },
    );
    const pruning = prune(context, baseDir).catch((error: unknown) => error);
    try {
      try {
        await entered.promise;
        expect(context.invalidateClientsForDevice.mock.calls.map(([id]) => id)).toEqual([
          "cli-first",
          "cli-second",
        ]);
        expect(request.isCurrent()).toBe(false);
      } finally {
        cleanup.reject(new Error("worker cleanup failed"));
        await pruning;
      }
      await expect(pruning).resolves.toMatchObject({ message: "worker cleanup failed" });
      expect(request.isCurrent()).toBe(false);
    } finally {
      releaseRun?.();
    }
  });

  test("retires stale node siblings across both pairing stores", async () => {
    const baseDir = await makeStateDir();
    await pairSilentDevice(baseDir, "node-stale", ["node"]);
    const nodeRequest = await requestNodePairing(
      { nodeId: "node-stale", displayName: "megaclaw" },
      baseDir,
    );
    await approveNodePairing(nodeRequest.request.requestId, { callerScopes: [] }, baseDir);
    const anchor = await pairSilentDevice(baseDir, "node-anchor", ["node"]);
    await registerApns(baseDir, "node-stale");
    await runNodeWakeAttempt({
      nodeId: "node-stale",
      force: true,
      throttleMs: 60_000,
      attempt: async (markAttempted) => {
        markAttempted();
        return { available: true, throttled: false, path: "sent", durationMs: 1 };
      },
    });
    await runNodeWakeNudgeAttempt({
      nodeId: "node-stale",
      throttleMs: 60_000,
      throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
      attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
    });
    enqueueNodePendingWork({ nodeId: "node-stale", type: "location.request" });
    enqueuePendingNodeAction({
      nodeId: "node-stale",
      pairingGeneration: "generation-1",
      command: "camera.capture",
      idempotencyKey: "idem-1",
      ttlMs: 60_000,
      maxPerNode: 10,
    });
    const wakeLifecycle = captureNodeWakeLifecycle("node-stale");

    const context = createPruneContext({
      workerEnvironmentIds: { "node-stale": ["environment-node-stale"] },
    });
    await expect(prune(context, baseDir, anchor.deviceId)).resolves.toMatchObject([
      { deviceId: "node-stale" },
    ]);
    await expect(listDevicePairing(baseDir)).resolves.toMatchObject({
      paired: [{ deviceId: "node-anchor" }],
    });
    await expect(listNodePairing(baseDir)).resolves.toMatchObject({ paired: [] });
    expect(getNodeWakeStateSnapshot("node-stale")).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork("node-stale", { includeDefaultStatus: false }).items).toEqual([]);
    expect(listPendingNodeActions({ nodeId: "node-stale", ttlMs: 60_000 })).toEqual([]);
    await expect(loadApnsRegistration("node-stale", baseDir)).resolves.toBeNull();
    expect(context.order).toEqual([
      "invalidate:node-stale",
      "worker:node-stale",
      "placement:environment-node-stale",
      "disconnect:node-stale",
    ]);
    const surface = context.nodeRegistry.updateSurface;
    expect(surface.mock.calls.map(([id]) => id)).toEqual(["node-stale"]);
    expect(context.logGateway.warn).not.toHaveBeenCalled();
    expect(context.broadcast).toHaveBeenCalledExactlyOnceWith(
      "node.pair.resolved",
      expect.objectContaining({ nodeId: "node-stale", decision: "removed" }),
      { dropIfSlow: true },
    );
  });

  test("keeps connected siblings and clears APNs for operator-only full prunes", async () => {
    const baseDir = await makeStateDir();
    await pairSilentDevice(baseDir, "cli-stale", ["operator", "node"]);
    await registerApns(baseDir, "cli-stale");
    await expect(
      removePairedDeviceRole({ deviceId: "cli-stale", role: "node", baseDir }),
    ).resolves.toEqual({ deviceId: "cli-stale", role: "node", removedDevice: false });
    await expect(loadApnsRegistration("cli-stale", baseDir)).resolves.toMatchObject({
      nodeId: "cli-stale",
    });
    await pairSilentDevice(baseDir, "cli-live");
    const anchor = await pairSilentDevice(baseDir, "cli-anchor");

    const context = createPruneContext({ connectedDeviceIds: ["cli-live"] });
    const pruned = await prune(context, baseDir, anchor.deviceId);

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["cli-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId).toSorted()).toEqual([
      "cli-anchor",
      "cli-live",
    ]);
    await expect(loadApnsRegistration("cli-stale", baseDir)).resolves.toBeNull();
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.disconnectClientsForDevice).toHaveBeenCalledExactlyOnceWith("cli-stale");
  });
});

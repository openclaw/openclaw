import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeRunnerInventoryIssue,
} from "../../infra/node-runner-inventory.js";
import { WorkerProviderError } from "../../plugins/types.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  bindDeviceWorkerReconciliation,
  createDeviceWorkerRuntime,
  reconcileDeviceWorker,
} from "./device-provider.js";

const DEVICE_ID = "device-session-host";
const DAY_MS = 24 * 60 * 60 * 1_000;
const PROFILE = { device: DEVICE_ID };
const LEASE = { leaseId: "device-lease", profile: PROFILE };
const AUTHORITY = { assertCurrent: () => {} };
function pairedDevice(
  deviceId = DEVICE_ID,
  nodeSurface?: PairedDevice["nodeSurface"],
): PairedDevice {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    role: "node",
    roles: ["node"],
    tokens: { node: { token: "fixture-token", role: "node", scopes: [], createdAtMs: 1 } },
    ...(nodeSurface ? { nodeSurface } : {}),
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function connectedNode(deviceId = DEVICE_ID, available = true): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available: available ? 2 : 0 } },
    commands: ["system.run"],
  };
}

function deviceRuntime(params: {
  getPairedDevice?: (deviceId: string) => Promise<PairedDevice | null>;
  listCurrentNodes: () => Promise<readonly NodeWorkerSupervisorNodeProof[]>;
  getIssue?: () => NodeRunnerInventoryIssue | undefined;
  now?: () => number;
}) {
  const runtime = createDeviceWorkerRuntime({
    getPairedDevice: params.getPairedDevice ?? (async (deviceId) => pairedDevice(deviceId)),
    ...(params.now ? { now: params.now } : {}),
  });
  runtime.bindNodeTransport({
    async getCurrentNode(nodeId) {
      return (await this.listCurrentNodes()).find((node) => node.nodeId === nodeId);
    },
    listCurrentNodes: params.listCurrentNodes,
    hasCurrentRunner: () => true,
    ...(params.getIssue ? { getIssue: params.getIssue } : {}),
    isCurrent: () => true,
    invoke: async () => ({ ok: false }),
  });
  return runtime;
}

describe("device worker provider", () => {
  it.each(["pairing", "presence"] as const)(
    "cancels an in-flight %s inspection without waiting for the read",
    async (phase) => {
      const entered = createDeferred();
      const release = createDeferred();
      const controller = new AbortController();
      const read = async (current: typeof phase) => {
        if (phase === current) {
          entered.resolve();
          await release.promise;
        }
      };
      const listCurrentNodes = vi.fn(async () => {
        await read("presence");
        return [connectedNode()];
      });
      const { provider } = deviceRuntime({
        getPairedDevice: async () => {
          await read("pairing");
          return pairedDevice();
        },
        listCurrentNodes,
      });
      let outcome: unknown;
      const inspection = provider.inspect({ ...LEASE, signal: controller.signal }).then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      try {
        await entered.promise;
        controller.abort();
        await vi.waitFor(() =>
          expect(outcome).toMatchObject({ name: "AbortError", cause: controller.signal.reason }),
        );
        if (phase === "pairing") {
          expect(listCurrentNodes).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await inspection;
      }
    },
  );

  it("binds targeted device reconciliation to the active worker service", async () => {
    const service = {};
    const reconcile = async (deviceId: string) => [`environment:${deviceId}`];

    await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([]);
    bindDeviceWorkerReconciliation(service, reconcile);
    await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([
      `environment:${DEVICE_ID}`,
    ]);
  });

  it("provisions deterministic node leases only for connected paired session hosts", async () => {
    const provider = deviceRuntime({
      listCurrentNodes: async () => [connectedNode()],
    }).provider;

    expect(provider.supportedExecutionModes).toEqual(["worker-turn", "remote-exec"]);
    const first = await provider.provision(PROFILE, "operation-1", AUTHORITY);
    const repeated = await provider.provision(PROFILE, "operation-1", AUTHORITY);
    const next = await provider.provision(PROFILE, "operation-2", AUTHORITY);

    expect(first).toEqual({
      leaseId: expect.stringMatching(/^device:[a-f0-9]{64}:[a-f0-9]{32}$/u),
      node: { deviceId: DEVICE_ID },
      sharedHost: true,
    });
    expect(repeated.leaseId).toBe(first.leaseId);
    expect(next.leaseId).not.toBe(first.leaseId);
    const getPairedDevice = vi.fn(async () => null);
    const listCurrentNodes = vi.fn(async () => []);
    const disconnected = deviceRuntime({ getPairedDevice, listCurrentNodes }).provider;
    const allocation = await disconnected.resolveAllocation(PROFILE, "operation-1");
    expect(allocation).toEqual({ leaseId: first.leaseId, sharedHost: true });
    await disconnected.destroy({ leaseId: allocation.leaseId, profile: PROFILE });
    expect(getPairedDevice).not.toHaveBeenCalled();
    expect(listCurrentNodes).not.toHaveBeenCalled();
  });

  it("returns the node's actionable disabled-host reason during provision", async () => {
    const message = "state directory /srv/node is group-writable; run chmod go-w /srv/node";
    const provider = deviceRuntime({
      listCurrentNodes: async () => [],
      getIssue: () => ({ code: "worker-host-unavailable", message }),
    }).provider;

    await expect(provider.provision(PROFILE, "operation", AUTHORITY)).rejects.toThrow(
      `device worker node ${DEVICE_ID} cannot host sessions: ${message}`,
    );
  });

  it.each([
    {
      name: "missing pairing",
      getPairedDevice: async () => null,
      listCurrentNodes: async () => [connectedNode()],
      expectedMessage: `device worker is not a paired node host: ${DEVICE_ID}`,
    },
    {
      name: "offline device",
      getPairedDevice: async () => pairedDevice(),
      listCurrentNodes: async () => [],
      expectedMessage: `device worker node is not connected: ${DEVICE_ID}; reconnect it before retrying`,
    },
  ])(
    "rejects $name during provision",
    async ({ getPairedDevice, listCurrentNodes, expectedMessage }) => {
      const provider = deviceRuntime({ getPairedDevice, listCurrentNodes }).provider;
      const provision = provider.provision(PROFILE, "operation", AUTHORITY);

      await expect(provision).rejects.toBeInstanceOf(WorkerProviderError);
      await expect(provision).rejects.toMatchObject({ message: expectedMessage });
    },
  );

  it.each([
    ["inside the dormancy ceiling", 6 * DAY_MS + 1, "dormant"],
    ["at the dormancy ceiling", 6 * DAY_MS, "unknown"],
    ["without exact legacy disconnect history", undefined, "dormant"],
  ] as const)("reports an offline paired node as %s", async (_, disconnectedAtMs, status) => {
    const nowMs = 20 * DAY_MS;
    const device = pairedDevice(DEVICE_ID, {
      createdAtMs: 1,
      approvedAtMs: 1,
      lastConnectedAtMs: DAY_MS,
      ...(disconnectedAtMs === undefined ? {} : { lastDisconnectedAtMs: disconnectedAtMs }),
    });
    // General device activity must not extend node-worker dormancy.
    device.lastSeenAtMs = nowMs;
    const provider = deviceRuntime({
      getPairedDevice: async () => device,
      listCurrentNodes: async () => [],
      now: () => nowMs,
    }).provider;

    await expect(provider.inspect(LEASE)).resolves.toEqual({ status });
  });

  it("reports active, dormant, and unknown from pairing plus live presence", async () => {
    let paired: PairedDevice | null = pairedDevice();
    let connected = true;
    let available = true;
    const runtime = deviceRuntime({
      getPairedDevice: async () => paired,
      listCurrentNodes: async () => (connected ? [connectedNode(DEVICE_ID, available)] : []),
    });
    const provider = runtime.provider;

    await expect(provider.inspect(LEASE)).resolves.toEqual({ status: "active", sharedHost: true });
    available = false;
    await expect(provider.inspect(LEASE)).resolves.toEqual({ status: "active", sharedHost: true });
    connected = false;
    await expect(provider.inspect(LEASE)).resolves.toEqual({ status: "dormant" });
    paired = null;
    await expect(provider.inspect(LEASE)).resolves.toEqual({ status: "unknown" });
    await expect(provider.destroy(LEASE)).resolves.toBeUndefined();
  });
});

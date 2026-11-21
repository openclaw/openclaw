import { describe, expect, it } from "vitest";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { NODE_RUNNER_UPDATE_REQUIRED_ISSUE } from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { selectDevicePlacementCandidates } from "./device-placement-selector.js";
import { bindDeviceWorkerAvailability, type DeviceWorkerAvailability } from "./device-provider.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";

const WORKER_REQUIREMENT: DevicePlacementRequirement = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};
const REMOTE_REQUIREMENT: DevicePlacementRequirement = {
  requiredNodeCommands: ["runtime.exec"],
  consumesWorkerSlot: false,
};
const CONFIG: OpenClawConfig = {
  gateway: { nodes: { commands: { allow: ["runtime.exec"] } } },
};

function nodeEnvironment(
  deviceId: string,
  available: number,
  overrides: Partial<EnvironmentSummary> = {},
  total = Math.max(available, 1),
): EnvironmentSummary {
  return {
    id: `node:${deviceId}`,
    type: "node",
    status: "available",
    sessionHost: true,
    workerSlots: { total, available },
    ...overrides,
  };
}

function expectCandidates(result: unknown, ...candidates: [string, number][]) {
  expect(result).toEqual({
    ok: true,
    candidates: candidates.map(([deviceId, availableSlots]) => ({ deviceId, availableSlots })),
  });
}

function expectError(result: unknown, message: string) {
  expect(result).toEqual({ ok: false, error: expect.stringContaining(message) });
}

function nodeProof(environment: EnvironmentSummary): NodeWorkerSupervisorNodeProof {
  const deviceId = environment.id.slice("node:".length);
  return createNodeWorkerBundleTestNode({
    nodeId: deviceId,
    workerHost: {
      capturedExecPolicy: true,
      promptContext: 1,
      capacity: environment.workerSlots ?? { total: 1, available: 0 },
    },
    commands: ["runtime.exec"],
  });
}

async function selectNodes(
  environments: EnvironmentSummary[],
  options: {
    requirement?: DevicePlacementRequirement;
    executionMode?: "worker-turn" | "remote-exec";
    availability?: (deviceId: string) => Promise<DeviceWorkerAvailability>;
    admittedSessions?: ReadonlyMap<string, number>;
    configureNode?: (node: NodeWorkerSupervisorNodeProof) => void;
  } = {},
) {
  const proofs = new Map(
    environments.map((environment) => {
      const proof = nodeProof(environment);
      options.configureNode?.(proof);
      return [proof.nodeId, proof] as const;
    }),
  );
  const environmentService = {};
  bindDeviceWorkerAvailability(
    environmentService,
    options.availability ??
      (async (deviceId) => {
        const node = proofs.get(deviceId);
        return node
          ? { available: true, node }
          : { available: false, unavailableReason: "unpaired" };
      }),
  );
  return await selectDevicePlacementCandidates({
    environments,
    nodeRegistry: { get: (deviceId) => proofs.get(deviceId) as never },
    environmentService,
    requirement: options.requirement ?? WORKER_REQUIREMENT,
    runtimeId: "test-runtime",
    executionMode:
      options.executionMode ??
      (options.requirement === REMOTE_REQUIREMENT ? "remote-exec" : "worker-turn"),
    config: CONFIG,
    getAdmittedSessionCounts: () => options.admittedSessions,
  });
}

describe("paired-device automatic placement selection", () => {
  const omitPolicy = (node: NodeWorkerSupervisorNodeProof) => {
    delete node.workerHost.capturedExecPolicy;
  };
  it("reports the required node update before capacity", async () => {
    expectError(
      await selectNodes([nodeEnvironment("outdated", 0)], { configureNode: omitPolicy }),
      "run openclaw update, then reconnect",
    );
  });

  it("keeps remote-exec independent of captured policy even when its harness consumes a slot", async () => {
    expectCandidates(
      await selectNodes([nodeEnvironment("remote", 2)], {
        executionMode: "remote-exec",
        requirement: { ...REMOTE_REQUIREMENT, consumesWorkerSlot: true },
        configureNode: omitPolicy,
      }),
      ["remote", 2],
    );
  });

  it("prefers lower admitted demand over advertised free slots", async () => {
    expectCandidates(
      await selectNodes(
        [
          nodeEnvironment("alpha", 2, {}, 2),
          nodeEnvironment("bravo", 1, {}, 2),
          nodeEnvironment("charlie", 1, {}, 2),
        ],
        {
          admittedSessions: new Map([
            ["alpha", 2],
            ["bravo", 1],
            ["charlie", 1],
          ]),
        },
      ),
      ["bravo", 1],
      ["charlie", 1],
      ["alpha", 2],
    );
  });

  it("retains physical occupancy for idle workers without double-counting admitted demand", async () => {
    const result = await selectNodes(
      [
        nodeEnvironment("idle-full", 0, {}, 2),
        nodeEnvironment("admitted", 1, {}, 2),
        nodeEnvironment("idle-spare", 1, {}, 2),
      ],
      { admittedSessions: new Map([["admitted", 1]]) },
    );

    expectCandidates(result, ["idle-spare", 1], ["admitted", 1]);
  });

  it("ranks current worker capacity instead of stale environment snapshots", async () => {
    const environments = [
      nodeEnvironment("charlie", 5),
      nodeEnvironment("bravo", 1),
      nodeEnvironment("alpha", 9),
    ];
    const liveCapacity = new Map([
      ["alpha", 2],
      ["bravo", 4],
      ["charlie", 2],
    ]);
    const result = await selectNodes(environments, {
      configureNode: (node) => {
        node.workerHost.capacity = { total: 9, available: liveCapacity.get(node.nodeId) ?? 0 };
      },
    });

    expectCandidates(result, ["bravo", 4], ["alpha", 2], ["charlie", 2]);
  });

  it("excludes disconnected, full, outdated, non-host, and no-longer-paired nodes", async () => {
    const environments = [
      nodeEnvironment("full", 0),
      nodeEnvironment("outdated", 3, {
        sessionHost: false,
        issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
      }),
      nodeEnvironment("offline", 3, { status: "unavailable" }),
      nodeEnvironment("not-host", 3, { sessionHost: false }),
      nodeEnvironment("unpaired", 3),
      nodeEnvironment("eligible", 1),
    ];
    const proofs = new Map(environments.map((node) => [node.id, nodeProof(node)]));
    const result = await selectNodes(environments, {
      availability: async (deviceId) =>
        deviceId === "unpaired"
          ? { available: false, unavailableReason: "unpaired" }
          : { available: true, node: proofs.get(`node:${deviceId}`) },
    });

    expectCandidates(result, ["eligible", 1]);
  });

  it("orders remote-exec hosts only by device identity, including hosts with no free slots", async () => {
    const result = await selectNodes(
      [nodeEnvironment("charlie", 5), nodeEnvironment("alpha", 0), nodeEnvironment("bravo", 2)],
      { requirement: REMOTE_REQUIREMENT, admittedSessions: new Map([["alpha", 20]]) },
    );

    expectCandidates(result, ["alpha", 0], ["bravo", 2], ["charlie", 5]);
  });

  it.each<[number, Partial<EnvironmentSummary>, string]>([
    [2, { sessionHost: false }, "pair a node, enable session hosting"],
    [2, { status: "unavailable" }, "all paired session-host nodes are disconnected"],
    [0, {}, "device worker is at capacity"],
    [
      0,
      { sessionHost: false, issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE] },
      "run openclaw update, then reconnect",
    ],
  ])("explains unavailable hosts (%s, %j)", async (available, overrides, message) => {
    expectError(await selectNodes([nodeEnvironment("node", available, overrides)]), message);
  });

  it("rejects runtimes that do not declare paired-device placement support", async () => {
    const result = await selectDevicePlacementCandidates({
      environments: [nodeEnvironment("eligible", 1)],
      nodeRegistry: { get: () => undefined },
      environmentService: {},
      requirement: undefined,
      runtimeId: "cloud-only",
      executionMode: "remote-exec",
      config: CONFIG,
    });

    expectError(result, "runtime cloud-only does not support paired-device placement");
  });
});

import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_RETAIN_COMMAND as RETAIN_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES as MAX_HASHES,
  NODE_WORKER_RETAIN_REQUEST_MAX_BYTES as MAX_BYTES,
  type NodeWorkerWorkspaceRetainResult as RetainResult,
} from "../../worker/node-workspace-retain-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof as NodeProof,
  NodeWorkerSupervisorTransport as Transport,
} from "../node-registry-private.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient, registerNodeSession } from "../node-registry.test-helpers.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import { WorkerPlacementInventoryChangedError } from "./placement-inventory-changed-error.js";
import type { WorkerSessionPlacementStore as PlacementStore } from "./placement-store.js";

type BundleStatus = NonNullable<ReturnType<NonNullable<Transport["getBundleStatus"]>>>;

const node = {
  nodeId: "node-1",
  connId: "connection-1",
  pairingIdentity: "pairing-1",
  pairingGeneration: "generation-1",
  clientId: "node-host",
  clientMode: "node",
  protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  workerHost: {
    enabled: true,
    capacity: { total: 2, available: 2 },
    bundleRetention: 1,
    bundleStatus: 1,
  },
  commands: [],
} as const;

function receipt(bundleHash: string, openclawVersion = "2026.8.9") {
  return { bundleHash, openclawVersion, protocolFeatures: [], installKind: "bundle" };
}

const previousHash = "b".repeat(64);
const currentHash = "c".repeat(64);
const installedStatus = (bundleHash: string, version = "2026.8.9") => ({
  bundleHash,
  status: { status: "installed" as const, version },
});
const baseManifest = `sha256:${"1".repeat(64)}`;
const manifestRead = (read: () => string[] | null) =>
  Object.assign(read, { [Symbol.dispose]: () => {} });
const bundleRetention = (artifact = receipt(currentHash), owned = false) => ({
  currentBuild: async () => artifact,
  isEnvironmentOwnedNode: () => owned,
});
const turnClaim = {
  owner: "worker",
  claimId: "claim-1",
  runId: "run-1",
  generation: 3,
  ownerEpoch: 7,
};

function environment(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "environment-1",
    nodeDeviceId: "node-1",
    bootstrapReceipt: null,
    ownerEpoch: 7,
    attachedSessionIds: ["session-1"],
    createdAtMs: 1,
    state: "attached",
    ...overrides,
  };
}

const retainResult = (overrides: Partial<RetainResult> = {}): RetainResult => ({
  applied: true,
  deleted: 0,
  hasMore: false,
  ...overrides,
});

function expectManifests(
  invoke: ReturnType<typeof createHarness>["invoke"],
  manifestRefs: string[] | null,
  index = 0,
) {
  expect(invoke.mock.calls[index]?.[0].params).toMatchObject({
    retain: [expect.objectContaining({ manifestRefs })],
  });
}

const retainEntry = {
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 7,
  manifestRefs: [`sha256:${"a".repeat(64)}`],
};

function placement(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    generation: 3,
    turnClaim: null,
    updatedAtMs: 2,
    state: "active",
    environmentId: "environment-1",
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
    workerBundleHash: "b".repeat(64),
    ...overrides,
  };
}

function boundedInventory(
  attachedCount: number,
  statusOnlyOverflow = false,
  hashCount = MAX_HASHES,
) {
  const padding = (index: number, full: number) =>
    !attachedCount || (statusOnlyOverflow && index >= attachedCount)
      ? 0
      : statusOnlyOverflow && index === attachedCount - 1
        ? 31
        : full;
  const environments = Array.from({ length: hashCount }, (_, index) => {
    const suffix = index.toString(16).padStart(8, "0");
    return environment({
      environmentId: `environment-${"e".repeat(padding(index, 220))}-${suffix}`,
      attachedSessionIds:
        index < attachedCount ? [`session-${"s".repeat(padding(index, 224))}-${suffix}`] : [],
      createdAtMs: statusOnlyOverflow && index === MAX_HASHES - 1 ? 10 : 1,
      bootstrapReceipt: receipt(
        index.toString(16).padStart(64, "0"),
        statusOnlyOverflow ? "2026.8.9" : "2026.8.1",
      ),
    });
  });
  const placements = environments.slice(0, attachedCount).map((entry, index) =>
    placement({
      sessionId: entry.attachedSessionIds[0],
      environmentId: entry.environmentId,
      workerBundleHash: index.toString(16).padStart(64, "0"),
    }),
  );
  return { environments, placements };
}

function createHarness(
  params: {
    environments?: unknown[];
    placements?: unknown[];
    pendingResults?: Awaited<ReturnType<PlacementStore["listPendingWorkspaceResultsAsync"]>>;
    prepareResultAuthority?: () => () => void;
    results?: RetainResult[];
    node?: NodeProof;
    currentBundleStatus?: BundleStatus;
    bundleRetention?: Parameters<typeof createNodeWorkspaceRetainCoordinator>[0]["bundleRetention"];
    additionalManifestRefs?: Parameters<
      typeof createNodeWorkspaceRetainCoordinator
    >[0]["additionalManifestRefs"];
    invokeError?: string;
    beforeDispatch?: () => void;
    onInvoke?: (index: number) => void;
  } = {},
) {
  const results = [...(params.results ?? [retainResult()])];
  let invokeIndex = 0;
  const invoke = vi.fn<Transport["invoke"]>(async () => {
    params.onInvoke?.(invokeIndex++);
    if (params.invokeError) {
      return { ok: false, error: { code: "UNAVAILABLE", message: params.invokeError } };
    }
    return {
      ok: true,
      payloadJSON: JSON.stringify(results.shift() ?? retainResult()),
    };
  });
  let currentBundleStatus = params.currentBundleStatus;
  const acceptBundleStatus = vi.fn<NonNullable<Transport["acceptBundleStatus"]>>(
    (_node, observation) => {
      currentBundleStatus = observation;
      return true;
    },
  );
  const transport: Transport = {
    async getCurrentNode(nodeId) {
      return (await this.listCurrentNodes()).find((entry) => entry.nodeId === nodeId);
    },
    hasCurrentRunner: () => false,
    listCurrentNodes: async () => [params.node ?? node],
    getBundleStatus: () => currentBundleStatus,
    acceptBundleStatus,
    isCurrent: () => true,
    async invoke(request) {
      params.beforeDispatch?.();
      if (
        (request.authorizeDispatch && !(await request.authorizeDispatch())) ||
        !request.isDispatchAuthorized()
      ) {
        return { ok: false, error: { code: "APPROVAL_AUTHORITY_CLOSED" } };
      }
      return invoke(request);
    },
  };
  const warn = vi.fn();
  const rows = () => (params.placements ?? [placement()]) as ReturnType<PlacementStore["list"]>;
  const findPlacement = (sessionId: string) => rows().find((row) => row.sessionId === sessionId);
  const placements: Pick<PlacementStore, "prepareMaintenancePlacements" | "prepareRuntimeRefresh"> =
    {
      prepareMaintenancePlacements: async () => ({
        placements: structuredClone(rows()),
        assertCurrent: () => {},
        release: () => {},
      }),
      prepareRuntimeRefresh: async (sessionId) => {
        const captured = structuredClone(findPlacement(sessionId));
        const assertPreparedResultCurrent = params.prepareResultAuthority?.();
        return {
          placement: captured,
          pendingResult: structuredClone(
            params.pendingResults?.find((row) => row.sessionId === sessionId),
          ),
          move: undefined,
          assertCurrent: () => {
            assertPreparedResultCurrent?.();
            if (!isDeepStrictEqual(captured, findPlacement(sessionId))) {
              throw new WorkerPlacementInventoryChangedError(new Set([sessionId]));
            }
          },
          release: () => {},
        };
      },
    };
  const coordinator = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: "gateway-test",
    environments: {
      list: () => (params.environments ?? [environment()]) as never,
    },
    placements,
    bundleRetention: params.bundleRetention,
    additionalManifestRefs: params.additionalManifestRefs,
    warn,
  });
  coordinator.bindTransport(transport);
  onTestFinished(() => coordinator.stop());
  return { coordinator, invoke, warn, acceptBundleStatus, placements };
}

async function startHarness(params: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(params);
  await harness.coordinator.start();
  return harness;
}

describe("node workspace retain coordinator", () => {
  it("accepts bundle status when placement metadata changes after node dispatch", async () => {
    const bundleHash = currentHash;
    const placements = [placement()];
    const { coordinator } = createHarness({
      placements,
      bundleRetention: bundleRetention(receipt(bundleHash, "2026.8.10")),
    });
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
      () => new NodeRegistry(),
    );
    const dispatched = createDeferredCore<string>();
    const client = makeClient("connection-1", "node-1", [], { clientId: "node-host" });
    vi.spyOn(client.socket, "send").mockImplementation((data) => {
      const frame = JSON.parse(data.toString()) as { event?: string; payload?: { id: string } };
      if (frame.event === "node.invoke.request" && frame.payload) {
        dispatched.resolve(frame.payload.id);
      }
    });
    registerNodeSession(nodeRegistry, client, { pairingGeneration: "generation-1" });
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId: "node-1",
      connId: "connection-1",
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: node.workerHost,
      },
    });
    coordinator.bindTransport(nodeWorkerSupervisorTransport);
    const publishing = coordinator.start();
    try {
      const id = await dispatched.promise;
      placements[0] = placement({ updatedAtMs: 3 });
      expect(
        nodeRegistry.handleInvokeResult({
          id,
          nodeId: "node-1",
          connId: "connection-1",
          ok: true,
          payloadJSON: JSON.stringify(
            retainResult({ bundleStatus: { bundleHash, status: "installed" } }),
          ),
        }),
      ).toBe(true);
      await publishing;
      expect(nodeWorkerSupervisorTransport.getBundleStatus?.("node-1")).toEqual(
        installedStatus(bundleHash, "2026.8.10"),
      );
    } finally {
      await coordinator.stop();
      nodeRegistry.unregister("connection-1");
      await publishing;
    }
  });

  it("publishes the complete durable retain snapshot for a connected device", async () => {
    const { invoke } = await startHarness({
      environments: [
        environment(),
        environment({
          environmentId: "environment-other",
          nodeDeviceId: "node-other",
        }),
        environment({ environmentId: "environment-terminal", state: "orphaned" }),
      ],
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      node,
      command: RETAIN_COMMAND,
      params: {
        version: 1,
        gatewayNamespace: "gateway-test",
        controllerId: expect.any(String),
        sequence: 1,
        bundleHashes: ["b".repeat(64)],
        retain: [retainEntry],
      },
    });
  });

  it("keeps prior retention nodes compatible without sending a status query", async () => {
    const { invoke, acceptBundleStatus } = await startHarness({
      node: {
        ...node,
        workerHost: { ...node.workerHost, bundleStatus: undefined },
      },
      environments: [environment({ bootstrapReceipt: receipt(previousHash) })],
    });

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      bundleHashes: ["b".repeat(64)],
    });
    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleStatusHash");
    expect(acceptBundleStatus).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it("does not request another bundle inspection after accepting its installed status", async () => {
    const bundleHash = previousHash;
    const { coordinator, invoke, acceptBundleStatus } = await startHarness({
      environments: [environment({ bootstrapReceipt: receipt(bundleHash) })],
      results: [
        retainResult({ bundleGeneration: 3, bundleStatus: { bundleHash, status: "installed" } }),
      ],
    });

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ bundleStatusHash: bundleHash });
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, installedStatus(bundleHash));
    await coordinator.schedule(node.nodeId);
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({ bundleHashes: [bundleHash] });
    expect(invoke.mock.calls[1]?.[0].params).not.toHaveProperty("bundleStatusHash");
    expect(acceptBundleStatus).toHaveBeenCalledOnce();
  });

  it("accepts status only from the final pass for the exact requested hash", async () => {
    const bundleHash = previousHash;
    const { coordinator, invoke, acceptBundleStatus } = await startHarness({
      environments: [environment({ bootstrapReceipt: receipt(bundleHash) })],
      results: [
        retainResult({
          deleted: 1,
          hasMore: true,
          bundleStatus: { bundleHash, status: "installed" },
        }),
        retainResult({ bundleStatus: { bundleHash, status: "missing" } }),
        retainResult({ bundleStatus: { bundleHash, status: "installed" } }),
      ],
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].params).toEqual(invoke.mock.calls[0]?.[0].params);
    expect(acceptBundleStatus).toHaveBeenCalledTimes(1);
    expect(acceptBundleStatus).toHaveBeenCalledWith(node, {
      bundleHash,
      status: { status: "missing" },
    });
    await coordinator.schedule(node.nodeId);
    expect(invoke.mock.calls[2]?.[0].params).toMatchObject({ bundleStatusHash: bundleHash });
    expect(acceptBundleStatus).toHaveBeenLastCalledWith(node, installedStatus(bundleHash));
  });

  it.each(["inspection failure", "different echoed hash"])(
    "clears stale status after %s",
    async (failure) => {
      const inspection = failure === "inspection failure";
      const { acceptBundleStatus, warn } = await startHarness({
        currentBundleStatus: inspection ? installedStatus(previousHash, "2026.8.8") : undefined,
        environments: [
          environment({ bootstrapReceipt: receipt(inspection ? currentHash : previousHash) }),
        ],
        invokeError: inspection ? "maintenance unavailable" : undefined,
        results: [retainResult({ bundleStatus: { bundleHash: currentHash, status: "installed" } })],
      });
      expect(acceptBundleStatus).toHaveBeenCalledWith(node, undefined);
      if (inspection) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("maintenance unavailable"));
      }
    },
  );

  it("keeps workspace retention compatible when bundle cleanup is not advertised", async () => {
    const currentBuild = vi.fn(async () => receipt(currentHash, "2026.9.3"));
    const { invoke, warn } = await startHarness({
      node: {
        ...node,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      },
      bundleRetention: { currentBuild, isEnvironmentOwnedNode: () => false },
    });

    expect(currentBuild).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0].params).toEqual({
      version: 1,
      gatewayNamespace: "gateway-test",
      controllerId: expect.any(String),
      sequence: 1,
      retain: [retainEntry],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps cloud workspace retention running when current build preparation rejects", async () => {
    const currentBuild = vi.fn(async () => receipt(currentHash));
    const { coordinator, invoke, warn } = await startHarness({
      environments: [
        environment({ nodeSetupId: "cloud-setup", bootstrapReceipt: receipt("b".repeat(64)) }),
      ],
      bundleRetention: { currentBuild, isEnvironmentOwnedNode: () => true },
      results: [retainResult({ bundleGeneration: 7 })],
    });

    currentBuild.mockRejectedValue(new Error("build preparation unavailable"));
    await coordinator.schedule(node.nodeId);
    expect(invoke).toHaveBeenCalledTimes(2);
    const input = invoke.mock.calls[1]?.[0].params;
    expect(input).toMatchObject({ retain: [retainEntry] });
    for (const key of ["bundleHashes", "acknowledgedBundleGeneration", "bundleStatusHash"]) {
      expect(input).not.toHaveProperty(key);
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Node bundle retention skipped (node-1): build preparation unavailable",
    );
  });

  it.each(["hash count", "combined bytes"])(
    "omits bundle retention when %s exceeds the wire bound",
    async (limit) => {
      const inventory =
        limit === "combined bytes"
          ? boundedInventory(1_500)
          : boundedInventory(0, false, MAX_HASHES + 1);
      const { invoke, warn } = await startHarness(inventory);
      expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleHashes");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("exceed the bounded maintenance request"),
      );
    },
  );

  it("keeps bounded bundle retention when only the status query exceeds one MiB", async () => {
    const { invoke, warn } = await startHarness(boundedInventory(1_241, true));

    const input = invoke.mock.calls[0]?.[0].params as Record<string, unknown>;
    expect(input.bundleHashes).toHaveLength(MAX_HASHES);
    expect(input).not.toHaveProperty("bundleStatusHash");
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const bundleStatusHash = (MAX_HASHES - 1).toString(16).padStart(64, "0");
    expect(bytes(input)).toBeLessThanOrEqual(MAX_BYTES);
    expect(bytes({ ...input, bundleStatusHash })).toBeGreaterThan(MAX_BYTES);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { placements: [] },
    { placements: [placement({ environmentId: "environment-other" })] },
  ])(
    "retains all manifests without preparing a repository owned by another environment: %j",
    async ({ placements }) => {
      const { invoke } = await startHarness({
        placements,
        additionalManifestRefs: async () => {
          throw new Error("Repository does not belong to this environment");
        },
      });

      expectManifests(invoke, null);
    },
  );

  it.each(["claimed", "pending", "stale-pending"])(
    "protects unsettled manifests for %s ownership",
    async (state) => {
      const { invoke } = await startHarness({
        placements: [placement({ turnClaim: state === "claimed" ? turnClaim : null })],
        pendingResults:
          state === "claimed"
            ? []
            : [
                {
                  sessionId: "session-1",
                  environmentId: "environment-1",
                  ownerEpoch: state === "pending" ? 7 : 6,
                  placementGeneration: 3,
                  claimId: "claim-1",
                  runId: "run-1",
                  gatewayInstanceId: "previous-gateway",
                  recoveryRequestedAtMs: null,
                  workspaceAcceptedAtMs: null,
                  stagedResultRef: null,
                },
              ],
      });
      expectManifests(invoke, state === "stale-pending" ? [`sha256:${"a".repeat(64)}`] : null);
    },
  );

  it("retains the immutable repository base after its accepted manifest advances and the node reconnects", async () => {
    const firstManifest = `sha256:${"2".repeat(64)}`;
    const latestManifest = `sha256:${"3".repeat(64)}`;
    const placements = [placement({ workspaceBaseManifestRef: firstManifest })];
    const options = {
      placements,
      node: { ...node, connId: "connection-1" },
      additionalManifestRefs: async () => manifestRead(() => [baseManifest]),
    };
    const { coordinator, invoke } = await startHarness(options);
    expectManifests(invoke, [baseManifest, firstManifest]);
    placements[0] = placement({ workspaceBaseManifestRef: latestManifest });
    options.node = { ...node, connId: "connection-2" };
    await coordinator.schedule("node-1");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      node: { connId: "connection-2" },
      params: {
        sequence: 2,
        retain: [expect.objectContaining({ manifestRefs: [baseManifest, latestManifest] })],
      },
    });
  });

  it.each(["initial placement read", "inventory read"] as const)(
    "retries the complete retention preparation after a stale %s",
    async (phase) => {
      const rows = [placement()];
      const nextManifest = `sha256:${"c".repeat(64)}`;
      const { coordinator, invoke, warn, placements } = createHarness({ placements: rows });
      const prepare = vi.spyOn(placements, "prepareRuntimeRefresh");
      if (phase === "initial placement read") {
        prepare.mockRejectedValueOnce(
          new WorkerPlacementInventoryChangedError(new Set(["session-1"])),
        );
      } else {
        const inventory = placements.prepareMaintenancePlacements;
        vi.spyOn(placements, "prepareMaintenancePlacements").mockImplementationOnce(async () => {
          const snapshot = await inventory();
          rows[0] = placement({ workspaceBaseManifestRef: nextManifest });
          return snapshot;
        });
      }
      await coordinator.start();
      expect(invoke).toHaveBeenCalledOnce();
      expectManifests(invoke, [rows[0]!.workspaceBaseManifestRef]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("does not retry a typed placement failure after invoking retention", async () => {
    const { invoke, warn } = await startHarness({
      onInvoke: () => {
        throw new WorkerPlacementInventoryChangedError(new Set(["session-1"]));
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    "current",
    "placement",
    "environment",
    "session",
    "pending",
    "result",
    "late-pending",
  ] as const)("rechecks %s ownership after repository manifest preparation", async (change) => {
    const placements = [placement()];
    const environments = [environment()];
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let resultRevision = 0;
    let sessionCurrent = true;
    const { coordinator, invoke, warn } = createHarness({
      placements,
      environments,
      prepareResultAuthority: () => {
        const capturedRevision = resultRevision;
        return () => {
          if (capturedRevision !== resultRevision) {
            throw new WorkerPlacementInventoryChangedError(new Set(["session-1"]));
          }
        };
      },
      beforeDispatch: () => {
        if (change === "late-pending") {
          // Both snapshots would retain every manifest, but revoked custody cannot dispatch.
          placements[0] = { ...placements[0]!, updatedAtMs: 3 };
        }
      },
      additionalManifestRefs: async () => {
        entered.resolve();
        await release.promise;
        return manifestRead(() => (sessionCurrent ? [baseManifest] : null));
      },
    });
    const startup = coordinator.start();
    try {
      await entered.promise;
      expect(invoke).not.toHaveBeenCalled();
      if (change === "placement") {
        placements[0] = placement({ generation: 4 });
      } else if (change === "environment") {
        environments[0] = environment({ ownerEpoch: 8 });
      } else if (change === "session") {
        sessionCurrent = false;
      } else if (change === "result") {
        resultRevision += 1;
      } else if (change === "pending" || change === "late-pending") {
        placements[0] = placement({ turnClaim });
      }
      release.resolve();
      await startup;
      if (change === "late-pending") {
        expect(invoke).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("APPROVAL_AUTHORITY_CLOSED"));
        return;
      }
      expect(invoke).toHaveBeenCalledOnce();
      expectManifests(
        invoke,
        ["current", "placement", "result"].includes(change)
          ? [baseManifest, `sha256:${"a".repeat(64)}`]
          : null,
      );
      if (change === "placement") {
        await coordinator.schedule("node-1");
        expect(invoke).toHaveBeenCalledTimes(2);
        expectManifests(invoke, [baseManifest, `sha256:${"a".repeat(64)}`], 1);
      }
    } finally {
      release.resolve();
      await startup;
    }
  });

  it("retains the current build without installing it or keeping unreferenced older builds", async () => {
    const artifact = receipt(currentHash, "2026.8.10");
    const input = {
      environments: [environment()],
      placements: [placement()],
      bundleRetention: bundleRetention(artifact),
      results: [
        retainResult({ bundleGeneration: 1 }),
        retainResult({ bundleGeneration: 1 }),
        retainResult({ deleted: 1, bundleGeneration: 1 }),
      ],
    };
    const { coordinator, invoke } = await startHarness(input);
    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("acknowledgedBundleGeneration");
    await coordinator.schedule();
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({
      acknowledgedBundleGeneration: 1,
      bundleHashes: ["b".repeat(64), artifact.bundleHash],
      bundleStatusHash: artifact.bundleHash,
    });
    input.environments = [];
    input.placements = [];
    await coordinator.schedule();
    expect(invoke.mock.calls[2]?.[0].params).toMatchObject({
      acknowledgedBundleGeneration: 1,
      bundleHashes: [artifact.bundleHash],
      retain: [],
    });
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      RETAIN_COMMAND,
      RETAIN_COMMAND,
      RETAIN_COMMAND,
    ]);
  });

  it("retains the current build until live cloud environments record it", async () => {
    const currentBuild = receipt(currentHash);
    const environments = [environment({ state: "ready", bootstrapReceipt: receipt(previousHash) })];
    const { coordinator, invoke } = await startHarness({
      environments,
      placements: [],
      bundleRetention: bundleRetention(currentBuild, true),
    });
    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      bundleHashes: [previousHash, currentBuild.bundleHash],
      bundleStatusHash: previousHash,
    });

    environments[0] = environment({ state: "ready", bootstrapReceipt: currentBuild });
    await coordinator.schedule(node.nodeId);
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({
      bundleHashes: [currentBuild.bundleHash],
    });

    environments[0] = environment({ state: "destroyed", bootstrapReceipt: currentBuild });
    await coordinator.schedule(node.nodeId);
    expect(invoke.mock.calls[2]?.[0].params).toMatchObject({ bundleHashes: [] });
  });

  it("maintains a newly connected node while another node's retention is held", async () => {
    const held = createDeferredCore();
    const second = { ...node, nodeId: "node-2", connId: "connection-2" };
    let nodes: NodeProof[] = [node];
    const invoke = vi.fn<Transport["invoke"]>(async (request) => {
      if (request.node.nodeId === node.nodeId) {
        await held.promise;
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify(retainResult()),
      };
    });
    const transport: Transport = {
      getCurrentNode: async (nodeId) => nodes.find((entry) => entry.nodeId === nodeId),
      listCurrentNodes: async () => nodes,
      hasCurrentRunner: () => true,
      isCurrent: () => true,
      invoke,
    };
    const { coordinator } = createHarness({ environments: [], placements: [] });
    coordinator.bindTransport(transport);
    const first = coordinator.start();
    try {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      nodes = [node, second];
      await coordinator.schedule(second.nodeId);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ node: second }));
    } finally {
      held.resolve();
      await first;
    }
  });

  it("rechecks environment ownership after resolving the current build before retaining it", async () => {
    const artifact = receipt(currentHash, "2026.8.10");
    const held = createDeferredCore<typeof artifact>();
    let environmentOwned = false;
    const retention = {
      isEnvironmentOwnedNode: () => environmentOwned,
      currentBuild: vi.fn(() => held.promise),
    };
    const { coordinator, invoke } = createHarness({
      environments: [],
      placements: [],
      bundleRetention: retention,
    });
    const startup = coordinator.start();
    await vi.waitFor(() => expect(retention.currentBuild).toHaveBeenCalledOnce());
    environmentOwned = true;
    held.resolve(artifact);
    await startup;
    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ bundleHashes: [] });
    expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundleStatusHash");
  });
});

import { expect, test, vi } from "vitest";
import type { EnvironmentSummary } from "../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../ui/src/i18n/index.ts";
import { projectDevicePlacements } from "../../ui/src/pages/new-session/device-placement.ts";
import { readDraftEnvironments } from "../../ui/src/pages/new-session/discovery.ts";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry, type NodeSessionConnectParams } from "./node-registry.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerPlacementMoveIntent } from "./worker-environments/placement-move-intent.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each([
  { state: "invocable", disabledReason: undefined },
  {
    state: "pending-approval",
    disabledReason:
      "Ask an administrator to approve the pending runtime.repository.v1 request, or pick another device.",
  },
  {
    state: "unauthorized",
    disabledReason:
      "Authorize runtime.repository.v1 in the Gateway node command policy, or pick another device.",
  },
  {
    state: "undeclared",
    disabledReason:
      "Make runtime.repository.v1 available on this device, then reconnect, or pick another device.",
  },
] as const)(
  "sessions.list carries automatic runtime requirements through the recovery picker: $state",
  async ({ state, disabledReason }) => {
    const registered = listRegisteredAgentHarnesses();
    const command = "runtime.repository.v1";
    const config = {
      gateway: {
        nodes: {
          commands: {
            allow: [command],
            deny: state === "unauthorized" ? [command] : [],
          },
        },
      },
    };
    const registry = new NodeRegistry({ getConfig: () => config });
    const client = createOperatorWsClient({
      clientInfo: { id: "node-host", mode: "node" },
      socket: { readyState: 1, bufferedAmount: 0, send: vi.fn() },
    });
    const connect: NodeSessionConnectParams = {
      ...client.connect,
      caps: ["session.host"],
      commands: state === "invocable" || state === "unauthorized" ? [command] : [],
      declaredCommands: state === "undeclared" ? [] : [command],
    };
    const node = registry.register(
      { ...client, connect },
      { pairingIdentity: "node-host", pairingGeneration: "node-host-generation" },
    );
    const connected = vi.spyOn(registry, "listConnectedForPairingStates").mockReturnValue([node]);
    registerAgentHarness({
      id: "repository-device",
      label: "Repository device",
      autoSelection: { providerIds: ["repository-provider"] },
      supports: () => ({ supported: true }),
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.repository.v1"],
          consumesWorkerSlot: false,
        },
      },
      runAttempt: async () => {
        throw new Error("projection must not execute the runtime");
      },
    });
    try {
      await i18n.setLocale("en");
      updateNodeRunnerInventory({
        registry,
        nodeId: node.nodeId,
        connId: node.connId,
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
        },
      });
      await createSessionStoreDir();
      await writeSessionStore({
        entries: {
          "agent:main:repository": {
            sessionId: "repository-session",
            updatedAt: 200,
            repositoryWorkspaceId: "repository-workspace",
            providerOverride: "repository-provider",
            modelOverride: "repository-model",
          },
        },
      });
      const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>("sessions.list", {});
      expect(result.ok).toBe(true);
      const runtime = result.payload?.sessions.find(
        (row) => row.sessionId === "repository-session",
      )?.agentRuntime;
      expect(runtime).toMatchObject({
        id: "repository-device",
        cloudPlacementExecutionMode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.repository.v1"],
          consumesWorkerSlot: false,
        },
      });
      const catalog = await directSessionReq<{ environments: EnvironmentSummary[] }>(
        "environments.list",
        { runtimeId: runtime?.id },
        {
          client: createOperatorWsClient(),
          context: { nodeRegistry: registry, getRuntimeConfig: () => config },
        },
      );
      expect(catalog.ok).toBe(true);
      expect(
        catalog.payload?.environments.find((environment) => environment.id === "node:node-host")
          ?.requiredNodeCommand,
      ).toEqual({ command, state });
      const devices = projectDevicePlacements(
        readDraftEnvironments(catalog.payload?.environments),
        runtime?.devicePlacement,
      );
      const device = devices.find((option) => option.deviceId === "node-host");
      expect(device).toBeDefined();
      expect(device?.selectable).toBe(state === "invocable");
      expect(device?.disabledReason).toBe(disabledReason);
    } finally {
      connected.mockRestore();
      registry.unregister(node.connId);
      restoreRegisteredAgentHarnesses(registered);
    }
  },
);

function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    sessionId: "sess-main",
    agentId: "main",
    sessionKey: "agent:main:main",
    executionMode: "worker-turn",
    state: "active",
    environmentId: "env-placement",
    generation: 7,
    activeOwnerEpoch: 12,
    workspaceBaseManifestRef: "manifest-base",
    remoteWorkspaceDir: "/workspace/main",
    workerBundleHash: ["a", "b"].join("").repeat(32),
    lastTranscriptAckCursor: 23,
    lastLiveEventAckCursor: 9,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 100,
    updatedAtMs: 300,
    stateChangedAtMs: 200,
  };
}

async function seedSessionRows(): Promise<void> {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: 200 },
      "agent:main:other": { sessionId: "sess-other", updatedAt: 100 },
    },
  });
}

test("sessions.list omits placement when the worker placement service is disabled", async () => {
  await seedSessionRows();

  const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>("sessions.list", {});

  expect(result.ok).toBe(true);
  expect(result.payload?.sessions).toHaveLength(2);
  expect(result.payload?.sessions.every((session) => session.placement === undefined)).toBe(true);
});

test.each([
  { name: "matching owner epoch", ownerEpoch: 12, expectedIdentity: true },
  { name: "missing environment", ownerEpoch: undefined, expectedIdentity: false },
  { name: "mismatched owner epoch", ownerEpoch: 13, expectedIdentity: false },
])(
  "sessions.list retains durable worker placement per resident row: $name",
  async ({ ownerEpoch, expectedIdentity }) => {
    await seedSessionRows();
    const placement = activePlacementRecord();
    const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
      expect(sessionIds).toHaveLength(1);
      return new Map(
        sessionIds.includes(placement.sessionId) ? [[placement.sessionId, placement]] : [],
      );
    });
    const diskSpace = {
      status: "warning" as const,
      availableBytes: 400,
      totalBytes: 1_000,
      observedAtMs: 350,
    };
    const identity = {
      providerId: "machine0",
      profileId: "team",
      machine: { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
    };
    const getEnvironment = vi.fn((environmentId: string) =>
      ownerEpoch !== undefined && environmentId === placement.environmentId
        ? { ...identity, ownerEpoch, state: "attached" }
        : undefined,
    );
    const context = {
      workerSessionPlacementService: { getMany },
      workerEnvironmentService: {
        get: getEnvironment,
        readMachineShape: () => identity.machine,
        machineShapeVersion: () => 0,
        inventoryVersion: () => 0,
      },
      workerPlacementDiskSpaceReader: { read: () => diskSpace, version: () => 1 },
      workerPlacementRunnerAvailabilityReader: {
        read: () => ({ kind: "device", status: "offline" }),
        version: () => 1,
      },
    };
    const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
      "sessions.list",
      {},
      { context },
    );

    expect(result.ok).toBe(true);
    expect(
      getMany.mock.calls.flatMap(([ids]) => ids).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["sess-main", "sess-other"]);
    const main = result.payload?.sessions.find((session) => session.sessionId === "sess-main");
    const other = result.payload?.sessions.find((session) => session.sessionId === "sess-other");
    expect(main?.placement).toStrictEqual({
      state: "active",
      environmentId: "env-placement",
      generation: 7,
      activeOwnerEpoch: 12,
      workspaceBaseManifestRef: "manifest-base",
      remoteWorkspaceDir: "/workspace/main",
      workerBundleHash: ["a", "b"].join("").repeat(32),
      lastTranscriptAckCursor: 23,
      lastLiveEventAckCursor: 9,
      createdAtMs: 100,
      updatedAtMs: 300,
      stateChangedAtMs: 200,
      diskSpace,
      runner: { kind: "device", status: "offline" },
      ...(expectedIdentity ? identity : {}),
    });
    expect(other?.placement).toBeUndefined();
    getMany.mockClear();
    expect((await directSessionReq("sessions.list", {}, { context })).ok).toBe(true);
    expect(getMany).not.toHaveBeenCalled();
  },
);

test.each(["provisioning", "syncing", "starting"] as const)(
  "sessions.describe preserves pre-epoch identity during %s",
  async (state) => {
    await seedSessionRows();
    const starting = {
      ...activePlacementRecord(),
      state: "starting" as const,
      activeOwnerEpoch: null,
      turnClaim: null,
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
    } satisfies WorkerSessionPlacementRecord;
    const syncing = {
      ...starting,
      state: "syncing" as const,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
    } satisfies WorkerSessionPlacementRecord;
    const placement: WorkerSessionPlacementRecord =
      state === "starting"
        ? starting
        : state === "syncing"
          ? syncing
          : { ...syncing, state, workerBundleHash: null };
    const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
      "sessions.describe",
      { key: "main" },
      {
        context: {
          workerSessionPlacementService: {
            getMany: () => new Map([[placement.sessionId, placement]]),
          },
          workerEnvironmentService: {
            get: () => ({
              providerId: "machine0",
              profileId: "team",
              ownerEpoch: 0,
              state: "provisioning",
            }),
            readMachineShape: () => undefined,
            machineShapeVersion: () => 0,
            inventoryVersion: () => 0,
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.payload?.session?.placement).toMatchObject({
      state,
      providerId: "machine0",
      profileId: "team",
    });
  },
);

test("sessions.list projects durable placement move progress", async () => {
  await seedSessionRows();
  const placement = activePlacementRecord();
  const move: WorkerPlacementMoveIntent = {
    operationId: "move:v1:opaque",
    sessionId: placement.sessionId,
    source: {
      generation: placement.generation,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    },
    target: { kind: "gateway" },
    abandonSource: false,
    lastError: "workspace reconciliation is waiting",
    createdAtMs: 320,
    updatedAtMs: 340,
  };
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>(
    () => new Map([[placement.sessionId, placement]]),
  );
  const getPlacementMoves = vi.fn<NonNullable<WorkerSessionPlacementReader["getPlacementMoves"]>>(
    () => new Map([[move.sessionId, move]]),
  );

  const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
    "sessions.list",
    {},
    { context: { workerSessionPlacementService: { getMany, getPlacementMoves } } },
  );

  expect(result.ok).toBe(true);
  const main = result.payload?.sessions.find((session) => session.sessionId === "sess-main");
  expect(main?.placementMove).toEqual({
    target: { kind: "gateway" },
    error: "workspace reconciliation is waiting",
    updatedAtMs: 340,
  });
  expect(main?.placementMove).not.toHaveProperty("operationId");
  expect(
    getPlacementMoves.mock.calls
      .map(([ids]) => ids)
      .toSorted((a, b) => a.join("\0").localeCompare(b.join("\0"))),
  ).toEqual([["sess-main"], ["sess-other"]]);
});

test("sessions.describe projects durable worker placement", async () => {
  await seedSessionRows();
  const placement = activePlacementRecord();
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
    expect(sessionIds).toHaveLength(1);
    return new Map(
      sessionIds.includes(placement.sessionId) ? [[placement.sessionId, placement]] : [],
    );
  });
  const diskSpace = {
    status: "critical" as const,
    availableBytes: 50,
    totalBytes: 1_000,
    observedAtMs: 350,
  };
  const context = {
    workerSessionPlacementService: { getMany },
    workerPlacementDiskSpaceReader: { read: () => diskSpace, version: () => 1 },
    workerPlacementRunnerAvailabilityReader: {
      read: () => ({ kind: "device", status: "offline" }),
      version: () => 1,
    },
  };

  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key: "main" },
    { context },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.session?.placement).toEqual({
    state: "active",
    environmentId: "env-placement",
    generation: 7,
    activeOwnerEpoch: 12,
    workspaceBaseManifestRef: "manifest-base",
    remoteWorkspaceDir: "/workspace/main",
    workerBundleHash: ["a", "b"].join("").repeat(32),
    lastTranscriptAckCursor: 23,
    lastLiveEventAckCursor: 9,
    createdAtMs: 100,
    updatedAtMs: 300,
    stateChangedAtMs: 200,
    diskSpace,
    runner: { kind: "device", status: "offline" },
  });

  // The list joins sibling hydration before we inspect all placement reads.
  const listed = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
    "sessions.list",
    {},
    { context },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions.map((session) => session.sessionId).toSorted()).toEqual([
    "sess-main",
    "sess-other",
  ]);
  expect(getMany.mock.calls.flatMap(([ids]) => ids).toSorted((a, b) => a.localeCompare(b))).toEqual(
    ["sess-main", "sess-other"],
  );
  expect(
    listed.payload?.sessions.find((session) => session.sessionId === "sess-main")?.placement,
  ).toEqual(result.payload?.session?.placement);
  expect(
    listed.payload?.sessions.find((session) => session.sessionId === "sess-other")?.placement,
  ).toBeUndefined();
});

test.each([
  { name: "without an environment", ownerEpoch: undefined, activeOwnerEpoch: 12, identity: false },
  {
    name: "with matching terminal environment provenance",
    ownerEpoch: 12,
    activeOwnerEpoch: 12,
    identity: true,
  },
  {
    name: "without identity from a reused environment",
    ownerEpoch: 13,
    activeOwnerEpoch: 12,
    identity: false,
  },
  {
    name: "without identity when no owner epoch was retained",
    ownerEpoch: 12,
    activeOwnerEpoch: null,
    identity: false,
  },
])(
  "sessions.describe projects a durable terminal reason $name",
  async ({ ownerEpoch, activeOwnerEpoch, identity }) => {
    await seedSessionRows();
    const active = activePlacementRecord();
    const placement = {
      ...active,
      state: "failed" as const,
      activeOwnerEpoch,
      turnClaim: null,
      recoveryError: "cloud worker disappeared: provider reported lease destroyed",
      terminalReason: "cloud worker disappeared: provider reported lease destroyed",
      terminalAtMs: 400,
    } satisfies WorkerSessionPlacementRecord;
    const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>(
      () => new Map([[placement.sessionId, placement]]),
    );

    const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
      "sessions.describe",
      { key: "main" },
      {
        context: {
          workerSessionPlacementService: { getMany },
          workerEnvironmentService: {
            get: () =>
              ownerEpoch === undefined
                ? undefined
                : {
                    providerId: "machine0",
                    profileId: "team",
                    ownerEpoch,
                    state: "destroyed",
                  },
            readMachineShape: () => undefined,
            machineShapeVersion: () => 0,
            inventoryVersion: () => 0,
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.payload?.session?.placement).toMatchObject({
      state: "failed",
      recoveryAction: "restart",
      terminalReason: "cloud worker disappeared: provider reported lease destroyed",
      terminalAtMs: 400,
    });
    const projected = result.payload?.session?.placement;
    expect(projected).toBeDefined();
    if (identity) {
      expect(projected).toMatchObject({ providerId: "machine0", profileId: "team" });
    } else {
      expect(projected).not.toHaveProperty("providerId");
      expect(projected).not.toHaveProperty("profileId");
    }
  },
);

test("sessions.describe requires worker teardown before failed-placement restart", async () => {
  await seedSessionRows();
  const active = activePlacementRecord();
  const placement = {
    ...active,
    state: "failed" as const,
    turnClaim: null,
    recoveryError: "worker unavailable",
    terminalReason: "worker unavailable",
    terminalAtMs: 400,
  } satisfies WorkerSessionPlacementRecord;

  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key: "main" },
    {
      context: {
        workerSessionPlacementService: {
          getMany: () => new Map([[placement.sessionId, placement]]),
        },
        workerEnvironmentService: {
          get: () => ({
            providerId: "machine0",
            profileId: "team",
            ownerEpoch: placement.activeOwnerEpoch,
            state: "failed",
            leaseId: "lease-live",
          }),
          readMachineShape: () => undefined,
          machineShapeVersion: () => 0,
          inventoryVersion: () => 0,
        },
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.session?.placement).toMatchObject({
    state: "failed",
    recoveryAction: "stop-first",
  });
});

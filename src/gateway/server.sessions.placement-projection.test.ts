import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  EnvironmentSummary,
  SessionPlacementMachine,
} from "../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../ui/src/i18n/index.ts";
import { projectDevicePlacements } from "../../ui/src/pages/new-session/device-placement.ts";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { createSessionPlacementFactsReader } from "./server-methods/sessions-read-cache.test-support.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import {
  disposeSessionReadContexts,
  trackSessionReadProjection,
} from "./session-read-contexts.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerPlacementMoveIntent } from "./worker-environments/placement-move-intent.types.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import { placementTurnOwner } from "./worker-environments/placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRecord,
} from "./worker-environments/placement-store.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./worker-environments/placement-test-fixtures.js";
import type { WorkerEnvironmentServiceRecord } from "./worker-environments/service-contract.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  await closeStateDatabaseForTest();
});

test.each([
  ["invocable", undefined],
  [
    "pending-approval",
    "paired-device command runtime.repository.v1 is awaiting pairing approval for node node-host; find its updated command surface request with openclaw nodes pending, then run openclaw nodes approve <requestId>",
  ],
  [
    "unauthorized",
    "paired-device command runtime.repository.v1 is blocked by Gateway policy for node node-host; allow it in gateway.nodes.commands.allow and remove any matching gateway.nodes.commands.deny entry",
  ],
  [
    "undeclared",
    "paired-device command runtime.repository.v1 is not advertised by node node-host; enable the plugin or node capability that provides this command on that node, then restart the node (openclaw node restart) and approve its updated command surface",
  ],
] as const)(
  "sessions.list carries automatic runtime requirements through the recovery picker: %s",
  async (state, disabledReason) => {
    const registered = listRegisteredAgentHarnesses();
    const command = "runtime.repository.v1";
    const commands = { allow: [command], deny: state === "unauthorized" ? [command] : [] };
    const config = { gateway: { nodes: { commands } } };
    const devicePlacement = { requiredNodeCommands: [command], consumesWorkerSlot: false };
    const registry = new NodeRegistry({ getConfig: () => config });
    const client = createOperatorWsClient({
      clientInfo: { id: "node-host", mode: "node" },
      socket: { readyState: 1, bufferedAmount: 0, send: vi.fn() },
    });
    const node = registry.register(
      {
        ...client,
        connect: {
          ...client.connect,
          caps: ["session.host"],
          commands: state === "invocable" || state === "unauthorized" ? [command] : [],
          declaredCommands: state === "undeclared" ? [] : [command],
        },
      },
      { pairingIdentity: "node-host", pairingGeneration: "node-host-generation" },
    );
    const connected = vi.spyOn(registry, "listConnectedForPairingStates").mockReturnValue([node]);
    registerAgentHarness({
      id: "repository-device",
      label: "Repository device",
      autoSelection: { providerIds: ["repository-provider"] },
      supports: () => ({ supported: true }),
      cloudPlacement: { mode: "remote-exec", devicePlacement },
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
        devicePlacement: { requiredNodeCommands: [command], consumesWorkerSlot: false },
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
      ).toEqual({ command, state, ...(disabledReason ? { message: disabledReason } : {}) });
      const devices = projectDevicePlacements(
        catalog.payload?.environments ?? [],
        runtime?.devicePlacement,
      );
      const device = devices.find((option) => option.deviceId === "node-host");
      expect(device).toMatchObject({ selectable: state === "invocable" });
      expect(device?.disabledReason).toBe(disabledReason);
    } finally {
      connected.mockRestore();
      registry.unregister(node.connId);
      restoreRegisteredAgentHarnesses(registered);
    }
  },
);

const placementIdentity = { providerId: "machine0", profileId: "team" };
const projectedActive = {
  state: "active" as const,
  environmentId: "env-placement",
  generation: 7,
  activeOwnerEpoch: 12,
  workspaceBaseManifestRef: "manifest-base",
  remoteWorkspaceDir: "/workspace/main",
  workerBundleHash: "ab".repeat(32),
  lastTranscriptAckCursor: 23,
  lastLiveEventAckCursor: 9,
  createdAtMs: 100,
  updatedAtMs: 300,
  stateChangedAtMs: 200,
};

function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...projectedActive,
    sessionId: "sess-main",
    agentId: "main",
    sessionKey: "agent:main:main",
    executionMode: "worker-turn",
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
  };
}

function failedPlacement(reason: string, activeOwnerEpoch: number | null = 12) {
  return {
    ...activePlacementRecord(),
    state: "failed" as const,
    activeOwnerEpoch,
    recoveryError: reason,
    terminalReason: reason,
    terminalAtMs: 400,
  } satisfies WorkerSessionPlacementRecord;
}

async function describeSession(
  context: NonNullable<Parameters<typeof directSessionReq>[2]>["context"],
  key = "main",
) {
  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key },
    { context },
  );
  expect(result.ok).toBe(true);
  return result.payload?.session;
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

function placementContext(
  placement: WorkerSessionPlacementRecord,
  environment?: Partial<WorkerEnvironmentServiceRecord> & { machine?: SessionPlacementMachine },
) {
  return {
    workerSessionPlacementService: {
      getMany: () => new Map([[placement.sessionId, placement]]),
    },
    workerEnvironmentService: {
      get: (id: string): WorkerEnvironmentServiceRecord | undefined =>
        environment && id === placement.environmentId
          ? {
              environmentId: placement.environmentId ?? "env-placement",
              ...placementIdentity,
              ownerEpoch: 12,
              state: "destroyed",
              leaseId: null,
              sharedHost: null,
              createdAtMs: 100,
              idleSinceAtMs: null,
              destroyRequestedAtMs: null,
              attachedSessionIds: [],
              desktopAvailable: false,
              desktopApps: [],
              tunnelStatus: "stopped",
              ...environment,
            }
          : undefined,
      readMachineShape: () => environment?.machine,
      machineShapeVersion: () => 0,
      inventoryVersion: () => 0,
    },
  };
}

async function projectedContext(
  context: NonNullable<Parameters<typeof createSessionRowProjection>[0]["context"]>,
  placementFactsReader: Parameters<typeof createSessionRowProjection>[0]["placementFactsReader"],
) {
  const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
  const projection = await createSessionRowProjection({ cfg, context, placementFactsReader });
  trackSessionReadProjection(projection);
  return bindSessionRowProjection(context, () => projection);
}

test.each([12, 13])(
  "sessions.list retains durable worker placement for resident rows: owner epoch %s",
  async (ownerEpoch) => {
    await seedSessionRows();
    const placement = activePlacementRecord();
    const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>(
      (sessionIds) =>
        new Map(sessionIds.includes(placement.sessionId) ? [[placement.sessionId, placement]] : []),
    );
    const diskSpace = {
      status: "warning" as const,
      availableBytes: 400,
      totalBytes: 1_000,
      observedAtMs: 350,
    };
    const identity = {
      ...placementIdentity,
      machine: { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
    };
    const context = {
      ...placementContext(placement, { ...identity, ownerEpoch, state: "attached" }),
      workerSessionPlacementService: { getMany },
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
      ...projectedActive,
      diskSpace,
      runner: { kind: "device", status: "offline" },
      ...(ownerEpoch === 12 ? identity : {}),
    });
    expect(other?.placement).toBeUndefined();
    getMany.mockClear();
    expect((await directSessionReq("sessions.list", {}, { context })).ok).toBe(true);
    expect(getMany).not.toHaveBeenCalled();
  },
);

test("sessions.describe preserves pre-epoch identity while starting", async () => {
  await seedSessionRows();
  const placement = {
    ...activePlacementRecord(),
    state: "starting" as const,
    activeOwnerEpoch: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
  } satisfies WorkerSessionPlacementRecord;
  const projected = await describeSession(
    placementContext(placement, { ownerEpoch: 0, state: "provisioning" }),
  );
  expect(projected?.placement).toMatchObject({ state: "starting", ...placementIdentity });
});

test.each([
  ["without an environment", undefined, 12, false, false],
  ["with matching terminal environment provenance", 12, 12, true, false],
  ["without identity when no owner epoch was retained", 12, null, false, false],
  ["while a move still owns recovery", 13, 12, false, true],
] as const)(
  "sessions.describe projects a durable terminal reason %s",
  async (_name, ownerEpoch, activeOwnerEpoch, identity, retryBlock) => {
    await seedSessionRows();
    const placement = failedPlacement(
      "cloud worker disappeared: provider reported lease destroyed",
      activeOwnerEpoch,
    );
    const move: WorkerPlacementMoveIntent = {
      operationId: "move:v1:opaque",
      sessionId: placement.sessionId,
      source: {
        generation: projectedActive.generation,
        environmentId: projectedActive.environmentId,
        ownerEpoch: 12,
      },
      target: { kind: "gateway" },
      abandonSource: false,
      lastError: null,
      createdAtMs: 320,
      updatedAtMs: 340,
    };
    const context = placementContext(
      placement,
      ownerEpoch === undefined ? undefined : { ownerEpoch },
    );
    const prepared = await projectedContext(
      context,
      createSessionPlacementFactsReader(
        context.workerSessionPlacementService,
        context.workerEnvironmentService.get,
        new Map(retryBlock ? [[placement.sessionId, move]] : []),
      ),
    );
    const projected = (await describeSession(prepared))?.placement;
    expect(projected).toMatchObject({
      state: "failed",
      recoveryAction: "restart",
      terminalReason: "cloud worker disappeared: provider reported lease destroyed",
      terminalAtMs: 400,
    });
    if (ownerEpoch !== undefined && activeOwnerEpoch !== null && !retryBlock) {
      expect(projected).toHaveProperty("retryOnSend", true);
    } else {
      expect(projected).not.toHaveProperty("retryOnSend");
    }
    if (identity) {
      expect(projected).toMatchObject(placementIdentity);
    } else {
      expect(projected).not.toHaveProperty("providerId");
      expect(projected).not.toHaveProperty("profileId");
    }
  },
);

function seedFailedPlacementWithRetainedResult(database: OpenClawStateDatabase, sessionId: string) {
  // Older terminal rows can retain unaccepted results beyond the active generation.
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(`UPDATE worker_session_placements SET turn_claim_owner = NULL,
        turn_claim_id = NULL, turn_claim_run_id = NULL, turn_claim_generation = NULL,
        turn_claim_owner_epoch = NULL WHERE session_id = ?`).run(sessionId);
      db.prepare(`UPDATE worker_session_placements SET state = 'failed',
        transition_generation = transition_generation + 3,
        recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
        terminal_at_ms = 1 WHERE session_id = ?`).run(sessionId);
    },
    { database },
  );
}

test.each([
  { recovery: "unstaged result", executionMode: "remote-exec" },
  { recovery: "rollback journal", executionMode: "worker-turn" },
] as const)(
  "sessions.describe waits for retained $recovery before offering retry on send",
  async ({ recovery, executionMode }) => {
    const { dir } = await createSessionStoreDir();
    const identity = {
      sessionId: "sess-retained-recovery",
      sessionKey: "agent:main:retained-recovery",
      agentId: "main",
    };
    await writeSessionStore({
      entries: { [identity.sessionKey]: { sessionId: identity.sessionId, updatedAt: 200 } },
    });
    const database = openOpenClawStateDatabase({ path: path.join(dir, "placements.sqlite") });
    const placements = createWorkerSessionPlacementStore({ database });
    const active = await advancePlacementFixtureToActive(placements, database, {
      ...identity,
      executionMode,
    });
    const journalOwner = {
      sessionId: identity.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    if (recovery === "unstaged result") {
      const claim = await placements.claimTurn({
        ...identity,
        owner: placementTurnOwner(active),
        claimId: "retained-claim",
        runId: "retained-run",
      });
      await placements.markWorkspaceResultPending(claim);
      seedFailedPlacementWithRetainedResult(database, identity.sessionId);
    } else {
      const basePack = Buffer.from("retained workspace rollback");
      await placements.beginWorkspaceReconciliation(journalOwner, {
        version: 1,
        temporaryNonce: "a".repeat(32),
        baseManifestRef: active.workspaceBaseManifestRef,
        currentManifestRef: `sha256:${"c".repeat(64)}`,
        baseEntries: [],
        appliedEntries: [],
        baseTree: "f".repeat(40),
        basePackSha256: createHash("sha256").update(basePack).digest("hex"),
        basePack,
      });
      const transitionOwner = {
        sessionId: identity.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      };
      const draining = await placements.startDrain({
        ...transitionOwner,
        expectedGeneration: active.generation,
      });
      const reconciling = await placements.startReconcile({
        ...transitionOwner,
        expectedGeneration: draining.generation,
      });
      await placements.fail({
        sessionId: identity.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "previous worker failure",
      });
    }
    writePlacementEnvironmentFixture(database, {
      environmentId: active.environmentId,
      state: "destroyed",
      ownerEpoch: active.activeOwnerEpoch + 1,
      attachedSessionIds: [],
    });
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    const context = {
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: placements,
      workerEnvironmentService: {
        get: () => undefined,
        readMachineShape: () => undefined,
      },
    };
    const prepared = await projectedContext(context, placements);
    const describe = () => describeSession(prepared, identity.sessionKey);
    const blocked = await describe();
    expect(blocked?.placement).toMatchObject({ state: "failed", recoveryAction: "restart" });
    expect(blocked?.placement).not.toHaveProperty("retryOnSend");
    expect(blocked?.placement).not.toHaveProperty("workspaceResultReconciling");

    if (recovery === "unstaged result") {
      const pending = await placements.listPendingWorkspaceResultsAsync(identity.sessionId);
      expect(pending).toHaveLength(1);
      await placements.abandonWorkspaceResult(pending[0]!);
    } else {
      await placements.abortWorkspaceReconciliation(journalOwner, { force: true });
    }
    expect(await describe()).toMatchObject({
      sessionId: identity.sessionId,
      placement: { ...blocked?.placement, retryOnSend: true },
    });
  },
);

test("sessions.describe requires worker teardown before failed-placement restart", async () => {
  await seedSessionRows();
  const placement = failedPlacement("worker unavailable");
  const projected = await describeSession(
    placementContext(placement, { state: "failed", leaseId: "lease-live" }),
  );
  expect(projected?.placement).toMatchObject({ state: "failed", recoveryAction: "stop-first" });
});

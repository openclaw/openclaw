import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { prepareAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import {
  createMainSessionRecoveryStoreFixture,
  exerciseProviderWaitCompatibility,
} from "../../agents/main-session-recovery/main-session-recovery-store.test-support.js";
import {
  withSessionPlacementTurnAdmission,
  installSessionPlacementAdmissionProvider,
} from "../../agents/session-placement-admission.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isAgentRunWaitingForCapacity } from "../../infra/agent-run-capacity-wait.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import * as backoff from "../../infra/backoff.js";
import { WorkerProviderError } from "../../plugins/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  drainSessionStateForTest,
  cleanupSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { bindDeviceWorkerAvailability, type DeviceWorkerAvailability } from "./device-provider.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  createProviderReplayNodeCarrierTunnel,
  executeProviderReplayNativeEffect,
  bindProviderReplayNodeAvailability,
  createProviderReplayDispatch,
} from "./provider-replay.test-support.js";
import { createWorkerEnvironmentService } from "./service.js";
import {
  createProvider,
  BUNDLE_ARTIFACT,
  BOOTSTRAP_RECEIPT,
  NODE_BOOTSTRAP,
} from "./service.test-support.js";
import { createNodeCarrier } from "./skill-resource-transfer.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import { waitForRecoveryWorkerCapacity } from "./worker-turn-capacity.js";
import {
  database,
  placements,
  root,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  cleanupWorkerTurnLauncherTest,
  turn as fixtureTurn,
  createWorkerSessionTurnPlacementProvider,
  setWorkerTurnSessionTarget,
} from "./worker-turn-launcher.test-support.js";

describe("recovery physical node capacity", () => {
  const fixture = createMainSessionRecoveryStoreFixture();
  const runId = "capacity-recovery";
  const sessionId = "capacity-session";
  const sessionKey = "agent:main:capacity";
  let storePath: string;
  let releaseContext: () => void;
  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "node-capacity",
    connId: "connection-capacity",
    pairingIdentity: "identity-capacity",
    pairingGeneration: "pairing-capacity",
    clientId: "node-host",
    clientMode: "node",
    protocolFeature: "node-worker-supervisor-v6",
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
  const claim: WorkerSessionTurnClaim = {
    sessionId,
    runId,
    claimId: "exact-claim",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "exact-environment", ownerEpoch: 3 },
  };
  const refusal = {
    launchId: "rejected-launch",
    planHash: "a".repeat(64),
    environmentId: "exact-environment",
    sessionId,
    ownerEpoch: 3,
    placementGeneration: 4,
    runId,
    nodeDeviceId: node.nodeId,
    connId: node.connId,
    pairingGeneration: node.pairingGeneration,
  };
  beforeEach(async () => {
    storePath = fixture.fixtureStore();
    const generation = getAgentEventLifecycleGeneration();
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        lifecycleRunId: runId,
        mainRestartRecovery: { cycleId: "cycle-capacity", revision: 1, chargedAttempts: 2 },
        restartRecoveryRuns: [{ runId, lifecycleGeneration: generation }],
      },
    );
    const context = claimAgentRunContext(
      runId,
      {
        sessionId,
        sessionKey,
        lifecycleGeneration: generation,
        projectSessionActive: true,
      },
      { trackOwner: true, ownsContext: true, protectFromSweep: true },
    );
    releaseContext = () => releaseAgentRunContext(runId, context);
  });
  afterEach(async () => {
    releaseContext();
    vi.restoreAllMocks();
    await fixture.resetCase();
  });

  async function start(
    availability: () => Promise<DeviceWorkerAvailability>,
    assertCurrent = () => {},
    signal?: AbortSignal,
  ) {
    const environments = {};
    bindDeviceWorkerAvailability(environments, availability);
    // Only the capacity owner's required turn facts are consumed here.
    const turn = {
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      abortSignal: signal,
    };
    const intent = await waitForRecoveryWorkerCapacity({
      environments,
      placements: {
        prepareTurnClaimAuthority: async () => ({
          claim,
          identity: { agentId: "main", sessionKey },
          isCurrent: () => true,
          onRevoked: () => () => {},
          release: () => {},
        }),
      },
      refusal,
      claim,
      turn,
      assertCurrent,
    });
    if (intent) {
      await intent.release();
    }
    return Boolean(intent);
  }

  it("keeps one durable visible claim across long waits and continues once after capacity returns", async () => {
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (ms) => {
      expect(ms).toBe(5_000);
      sleeping.resolve();
      await release.promise;
    });
    let available = 0;
    const operation = start(async () => ({
      available: true,
      node: { ...node, workerHost: { ...node.workerHost, capacity: { total: 1, available } } },
    }));
    await awaitGateBeforeSettlement(
      sleeping.promise,
      operation,
      "Capacity operation settled before waiting",
    );
    const waiting = loadSessionEntry({ sessionKey, storePath })!;
    expect(waiting.mainRestartRecovery).toMatchObject({
      chargedAttempts: 2,
      capacityWait: {
        runId,
        worker: { claimId: claim.claimId, ownerEpoch: 3, placementGeneration: 4 },
      },
    });
    expect(waiting.mainRestartRecovery?.tombstone).toBeUndefined();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 24 * 60 * 60_000);
    available = 1;
    release.resolve();
    await operation;
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toMatchObject({
      chargedAttempts: 2,
    });
    expect(
      loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.capacityWait,
    ).toBeUndefined();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(false);
  });

  it.each([
    "known",
    "unsupported",
    "missing-environment",
    "mixed",
    "started",
    "different-run",
    "different-attempt",
  ] as const)(
    "round-trips provider wait metadata and refunds only the known exact unstarted marker (%s)",
    (change) =>
      exerciseProviderWaitCompatibility({ change, sessionId, sessionKey, storePath, runId }),
  );

  it.each([
    "pause",
    "manual",
    "archive",
    "revision",
    "cancel",
    "actor",
    "claim",
    "connection",
  ] as const)("rejects late capacity after %s changes", async (change) => {
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      sleeping.resolve();
      await release.promise;
    });
    let changed = false;
    const controller = new AbortController();
    const operation = start(
      async () => ({
        available: true,
        node: changed
          ? {
              ...node,
              connId: change === "connection" ? "replacement" : node.connId,
              workerHost: { ...node.workerHost, capacity: { total: 1, available: 1 } },
            }
          : node,
      }),
      () => {
        if (changed && (change === "actor" || change === "claim")) {
          throw new Error(`${change} authority closed`);
        }
      },
      controller.signal,
    );
    const outcome = operation.catch((error: unknown) => error);
    await awaitGateBeforeSettlement(
      sleeping.promise,
      operation,
      "Capacity operation settled before waiting",
    );
    if (change === "pause") {
      const current = loadSessionEntry({ sessionKey, storePath })!;
      current.mainRestartRecovery!.pause = {
        reason: "unverifiable-external-effect",
        pausedAtMs: 200,
      };
      await replaceSessionEntry({ sessionKey, storePath }, current);
    }
    if (change === "manual" || change === "archive" || change === "revision") {
      const current = loadSessionEntry({ sessionKey, storePath })!;
      if (change === "archive") {
        current.archivedAt = 200;
      } else if (change === "revision") {
        current.lifecycleRevision = "replacement-lifecycle";
      } else {
        current.goal = {
          schemaVersion: 1,
          id: "goal-manual",
          objective: "Hold this session",
          status: "paused",
          createdAt: 100,
          updatedAt: 200,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        };
        current.goalPauseOrigin = "manual";
      }
      await replaceSessionEntry({ sessionKey, storePath }, current);
    }
    if (change === "cancel") {
      controller.abort(new Error("cancelled"));
    }
    changed = true;
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
      2,
    );
  });

  it("refuses a pause arriving at the final wait-clear write before returning to execution", async () => {
    vi.spyOn(backoff, "sleepWithAbort").mockResolvedValue(undefined);
    let reads = 0;
    const commit = recoveryStore.commitMainSessionRecovery;
    vi.spyOn(recoveryStore, "commitMainSessionRecovery").mockImplementation(async (params) => {
      if (
        params.command.kind === "finish_worker_capacity" ||
        params.command.kind === "cancel_capacity_wait"
      ) {
        const current = loadSessionEntry({ sessionKey, storePath })!;
        current.mainRestartRecovery!.pause = {
          reason: "unverifiable-external-effect",
          pausedAtMs: 200,
        };
        await replaceSessionEntry({ sessionKey, storePath }, current);
      }
      return await commit(params);
    });
    await expect(
      start(async () => ({
        available: true,
        node:
          ++reads === 1
            ? node
            : {
                ...node,
                workerHost: { ...node.workerHost, capacity: { total: 1, available: 1 } },
              },
      })),
    ).rejects.toThrow("recovery intent changed");
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.pause).toBeDefined();
  });

  it("does not classify unknown availability as capacity or reserve a new operation", async () => {
    const sleep = vi.spyOn(backoff, "sleepWithAbort");
    await expect(
      start(async () => ({ available: false, unavailableReason: "disconnected" })),
    ).rejects.toThrow("runner is offline");
    expect(sleep).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.capacityWait,
    ).toBeUndefined();
  });

  it("refunds only the exact never-started wait during restart marking", async () => {
    const current = loadSessionEntry({ sessionKey, storePath })!;
    current.mainRestartRecovery!.acknowledgedPause = {
      reason: "unverifiable-external-effect",
      pausedAtMs: 90,
    };
    await replaceSessionEntry({ sessionKey, storePath }, current);
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      sleeping.resolve();
      await release.promise;
    });
    let closed = false;
    const operation = start(
      async () => ({ available: true, node }),
      () => {
        if (closed) {
          throw new Error("retired");
        }
      },
    ).catch((error: unknown) => error);
    await awaitGateBeforeSettlement(
      sleeping.promise,
      operation,
      "Capacity operation settled before waiting",
    );
    await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: 500,
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toMatchObject({
      cycleId: "cycle-capacity",
      chargedAttempts: 1,
    });
    await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: 600,
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
      1,
    );
    closed = true;
    release.resolve();
    expect(await operation).toBeInstanceOf(Error);
  });

  it("reopens the durable physical wait from the accepted snapshot without charging it", async () => {
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      sleeping.resolve();
      await release.promise;
    });
    let retired = false;
    const operation = start(
      async () => ({ available: true, node }),
      () => {
        if (retired) {
          throw new Error("retired");
        }
      },
    ).catch((error: unknown) => error);
    await awaitGateBeforeSettlement(
      sleeping.promise,
      operation,
      "Capacity operation settled before waiting",
    );
    const snapshot = loadSessionEntry({ sessionKey, storePath })!;
    retired = true;
    release.resolve();
    expect(await operation).toBeInstanceOf(Error);
    releaseContext();
    // Restored state contains the final accepted pre-execution wait, not the old process cleanup.
    await replaceSessionEntry({ sessionKey, storePath }, snapshot);
    await cleanupSessionStateForTest({ stateDir: path.dirname(storePath) });
    const reopened = loadSessionEntry({ sessionKey, storePath })!;
    expect(reopened.mainRestartRecovery?.capacityWait).toEqual(
      snapshot.mainRestartRecovery?.capacityWait,
    );
    expect(reopened.mainRestartRecovery?.chargedAttempts).toBe(2);
    await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: Date.now(),
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
      1,
    );
  });

  it.each(["started", "different-run", "different-attempt"] as const)(
    "never refunds a %s capacity marker",
    (change) => {
      const entry: InternalSessionEntry = {
        sessionId,
        updatedAt: 100,
        lifecycleRunId: change === "different-run" ? "another-run" : runId,
        mainRestartRecovery: {
          cycleId: "cycle-capacity",
          revision: 1,
          chargedAttempts: 2,
          ...(change === "started" ? { startedAttempt: 2 } : {}),
          capacityWait: {
            runId,
            lifecycleGeneration: "old-generation",
            sinceMs: 100,
            worker: {
              environmentId: "exact-environment",
              ownerEpoch: 3,
              placementGeneration: 4,
              claimId: claim.claimId,
              nodeDeviceId: node.nodeId,
              connId: node.connId,
              pairingGeneration: node.pairingGeneration,
              launchId: refusal.launchId,
              planHash: refusal.planHash,
              attempt: change === "different-attempt" ? 1 : 2,
            },
          },
        },
      };
      transitionMainSessionRecovery(entry, {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: 200,
      });
      expect(entry.mainRestartRecovery?.chargedAttempts).toBe(2);
    },
  );
});

describe("settled provider capacity recovery", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "goal",
    "accepted-no-goal",
    "cancel",
    "manual-pause",
    "role",
    "placement",
    "lost-reply",
  ] as const)(
    "keeps original native work uncharged until exact provider settlement permits one effect (%s)",
    async (change) => {
      const runId = "provider-recovery";
      const sessionId = "provider-capacity-session";
      const sessionKey = "agent:main:provider-capacity";
      setWorkerTurnSessionTarget({ ...sessionTarget, sessionId, sessionKey });
      const generation = getAgentEventLifecycleGeneration();
      // extensions/codex/harness.ts owns this public remote-exec requirement;
      // worker.workspace.exec.v1 is private owner transport, never a public grant.
      const runtimeCommand = "codex.exec-server.stdio.v1";
      const cfg = {
        gateway: { nodes: { commands: { allow: [runtimeCommand] } } },
        session: { store: sessionTarget.storePath },
        cloudWorkers: { profiles: { development: { provider: "fake", settings: {} } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(createContext(), () => projection);
      context.getRuntimeConfig = () => cfg;
      const operator = await captureGatewayOperatorRunAuthority({
        context,
        client: createOperatorClient({
          profileName: "original-capacity-issuer",
          scopes: ["operator.write"],
        }),
      });
      expect(operator).toBeDefined();
      const authority = operator!.authority;
      const originalActor = {
        type: "human" as const,
        source: "profile" as const,
        id: authority.profileId,
      };
      const goal =
        change === "accepted-no-goal"
          ? undefined
          : {
              schemaVersion: 1 as const,
              id: "capacity-goal",
              objective: "Continue accepted work",
              status: "active" as const,
              createdAt: 100,
              updatedAt: 100,
              tokenStart: 0,
              tokensUsed: 0,
              continuationTurns: 0,
            };
      await replaceSessionEntry(sessionTarget, {
        sessionId,
        updatedAt: Date.now(),
        createdActor: originalActor,
        lifecycleRunId: runId,
        goal,
        ...(goal ? { restartRecoveryGoal: { id: goal.id, sessionId, capturedAtMs: 100 } } : {}),
        mainRestartRecovery: { cycleId: "provider-cycle", revision: 1, chargedAttempts: 1 },
        restartRecoveryRuns: [{ runId, lifecycleGeneration: generation }],
      });
      const runContext = claimAgentRunContext(
        runId,
        {
          sessionId,
          sessionKey,
          agentId: "main",
          lifecycleGeneration: generation,
          projectSessionActive: true,
        },
        { ownsContext: true, trackOwner: true },
      );
      const store = await createWorkerEnvironmentStore({ database });
      await fs.mkdir(path.join(root, "node"));
      const carrier = await createNodeCarrier(path.join(root, "node"));
      const { nodeTunnelManager } = createProviderReplayNodeCarrierTunnel(carrier, sessionId);
      let shortage = false;
      let successfulAllocations = 0;
      const operationIds: string[] = [];
      // Only external provider, installation and node transport leaves are synthetic.
      const provider = createProvider({
        requiresNodeEnrollment: true,
        provisionBeforeInstallation: true,
        resolveAllocation: async (_profile, operationId) => ({
          leaseId: operationId,
          sharedHost: false,
        }),
        provision: async (_profile, operationId, options) => {
          options?.assertCurrent?.();
          operationIds.push(operationId);
          if (shortage) {
            if (change === "lost-reply") {
              throw new Error("provider allocation reply lost");
            }
            throw WorkerProviderError.capacityShortage({
              operationId,
              leaseId: operationId,
              attemptName: "fixed-vm",
              attemptNonce: "fixed-nonce",
              providerCode: "AllocationFailed",
            });
          }
          successfulAllocations += 1;
          const enrollment = await options?.beginNodeEnrollment?.();
          return {
            leaseId: operationId,
            sharedHost: false,
            node: { deviceId: await enrollment!.waitForDeviceId() },
          };
        },
      });
      const features = [
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
        WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
      ];
      const service = createWorkerEnvironmentService({
        scheduler: createTestGatewayScheduler(),
        store,
        getConfig: () => cfg,
        resolveProvider: () => provider,
        prepareInstallation: async () => ({ ...BUNDLE_ARTIFACT, protocolFeatures: features }),
        bootstrapWorker: async () => {
          throw new Error("SSH installation must not run");
        },
        prepareNodeBootstrap: async () => NODE_BOOTSTRAP.sha256,
        prepareNodeEnrollment: async (record) => {
          const enrolled = await store.ensureNodeEnrollment(record.environmentId);
          return {
            mode: "connect",
            setupCode: "synthetic-setup",
            setupId: enrolled.nodeSetupId!,
            openclawVersion: BUNDLE_ARTIFACT.openclawVersion,
            nodeBootstrap: NODE_BOOTSTRAP,
            displayName: "Synthetic node",
            waitForDeviceId: async () => "capacity-node",
          };
        },
        ensureNodeWorkerBundle: async () => ({ ...BOOTSTRAP_RECEIPT, protocolFeatures: features }),
        nodeTunnelManager,
        executeInference: async () => ({
          type: "error",
          reason: "cancelled",
          message: "unused external model leaf",
        }),
      });
      bindProviderReplayNodeAvailability(service, [runtimeCommand]);
      // Remote-exec prepares a workspace; the supervisor's model-child slot is not consumed.
      const requirement = async () => ({
        requiredNodeCommands: [runtimeCommand],
        consumesWorkerSlot: false,
      });
      const dispatch = createProviderReplayDispatch({
        environments: service,
        placements,
        resolveWorkspace: async () => ({ kind: "local", path: root }),
        resolveDevicePlacementRequirement: requirement,
        isCurrentNodePlacement: () => true,
      });
      const request = {
        sessionId,
        sessionKey,
        agentId: "main",
        profileId: "development",
        executionMode: "remote-exec" as const,
      };
      const sleeping = createDeferred();
      const release = createDeferred();
      const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
        sleeping.resolve();
        await release.promise;
      });
      const controller = new AbortController();
      const baseInput = fixtureTurn(runId);
      const input = { ...baseInput, sessionId, config: { ...baseInput.config, ...cfg } };
      const preparedRunAdmission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: input.preparedRunAdmission.operationalRunInstance,
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "worker", boundary: "test.provider-capacity", state: "present" },
        },
        operatorAuthority: authority,
        assertSourceCurrent: authority.assertCurrent,
      });
      let uninstall = () => {};
      let execution: Promise<unknown> | undefined;
      let effects = 0;
      let nextAdmission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
      let nextRunContext: ReturnType<typeof claimAgentRunContext> = undefined;
      const effect = async () => {
        authority.assertCurrent();
        expect(loadSessionEntry(sessionTarget)?.createdActor).toEqual(originalActor);
        expect(loadSessionEntry(sessionTarget)?.goal?.id).toBe(goal?.id);
        await executeProviderReplayNativeEffect(carrier, authority.assertCurrent);
        expect(carrier.binding.sessionId).toBe(sessionId);
        effects += 1;
        return { payloads: [], meta: { durationMs: 0 } };
      };
      try {
        const predecessor = await service.createWithRequest({
          profileId: "development",
          idempotencyKey: "predecessor",
          executionMode: "remote-exec",
        });
        await service.destroy(predecessor.environmentId);
        const original = await placements.startDispatch(request);
        const provisioning = await placements.transition({
          sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: original.generation,
          patch: { environmentId: predecessor.environmentId },
        });
        await placements.fail({
          sessionId,
          expectedGeneration: provisioning.generation,
          recoveryError: "previous exact worker retired before activation",
        });
        shortage = true;
        const native = createWorkerSessionTurnPlacementProvider({
          environments: service,
          placements,
          resolveWorkspace: async () => ({ kind: "local", path: root }),
          redispatchPlacement: createWorkerPlacementRedispatch({
            placements,
            dispatch: dispatch.dispatch,
            resolveDevicePlacementRequirement: requirement,
          }),
        });
        uninstall = installSessionPlacementAdmissionProvider(native);
        execution = withSessionPlacementTurnAdmission(
          { ...request, runId },
          { ...input, preparedRunAdmission, abortSignal: controller.signal },
          effect,
        ).catch((error: unknown) => error);
        if (change === "lost-reply") {
          expect(await execution).toBeInstanceOf(Error);
          expect(sleep).not.toHaveBeenCalled();
          expect(effects).toBe(0);
          expect(
            store
              .list()
              .some(
                (row) =>
                  row.provisionOperationId === operationIds.at(-1) &&
                  row.destroyRequestedAtMs !== null,
              ),
          ).toBe(true);
          return;
        }
        await awaitGateBeforeSettlement(
          sleeping.promise,
          execution.then((result) => {
            if (result instanceof Error) {
              throw result;
            }
            return result;
          }),
          "native recovery ended before provider wait",
        );
        const waiting = loadSessionEntry(sessionTarget)!;
        expect(waiting.mainRestartRecovery).toMatchObject({
          chargedAttempts: 1,
          capacityWait: {
            provider: { kind: "settled-shortage-v1", operationId: operationIds.at(-1) },
          },
        });
        expect(isAgentRunWaitingForCapacity(runId)).toBe(true);
        expect(effects).toBe(0);
        expect(
          store.list().find((row) => row.provisionOperationId === operationIds.at(-1))?.state,
        ).toBe("destroyed");
        if (change === "goal" || change === "accepted-no-goal") {
          await commitMainSessionRecovery({
            target: sessionTarget,
            command: { kind: "mark_interrupted", cycleId: "unused", now: Date.now() },
          });
          controller.abort(new Error("Gateway retired while waiting"));
          release.resolve();
          expect(await execution).toBeInstanceOf(Error);
          await drainSessionStateForTest({ stateDir: root });
          await closeOpenClawAgentDatabasesAsync(root);
          const reopened = loadSessionEntry(sessionTarget)!;
          expect(reopened.mainRestartRecovery?.capacityWait?.provider).toEqual({
            ...waiting.mainRestartRecovery?.capacityWait?.provider,
            refunded: true,
          });
          expect(reopened.mainRestartRecovery?.chargedAttempts).toBe(0);
          await commitMainSessionRecovery({
            target: sessionTarget,
            command: { kind: "mark_interrupted", cycleId: "unused", now: Date.now() },
          });
          expect(loadSessionEntry(sessionTarget)?.mainRestartRecovery?.chargedAttempts).toBe(0);
          const restored = loadSessionEntry(sessionTarget)!;
          const nextRunId = "provider-recovery-after-reopen";
          await commitMainSessionRecovery({
            target: sessionTarget,
            command: {
              kind: "prepare_attempt",
              attempt: 1,
              lifecycleGeneration: generation,
              now: Date.now(),
              runId: nextRunId,
              observation: {
                sessionId,
                cycleId: restored.mainRestartRecovery!.cycleId,
                revision: restored.mainRestartRecovery!.revision,
              },
              executionIdentity: { state: "disabled" },
            },
          });
          expect(
            (
              await commitMainSessionRecovery({
                target: sessionTarget,
                command: {
                  kind: "admit_recovery",
                  sessionId,
                  runId: nextRunId,
                  lifecycleGeneration: generation,
                  now: Date.now(),
                },
              })
            ).transition.kind,
          ).toBe("admitted_recovery");
          const nextBaseInput = fixtureTurn(nextRunId);
          const nextInput = {
            ...nextBaseInput,
            sessionId,
            config: { ...nextBaseInput.config, ...cfg },
          };
          nextAdmission = prepareAgentRunAdmission({
            cfg,
            operationalRunInstance: nextInput.preparedRunAdmission.operationalRunInstance,
            facts: {
              runId: nextRunId,
              agentId: "main",
              ingress: { kind: "worker", boundary: "test.provider-capacity", state: "present" },
            },
            operatorAuthority: authority,
            assertSourceCurrent: authority.assertCurrent,
          });
          nextRunContext = claimAgentRunContext(
            nextRunId,
            {
              sessionId,
              sessionKey,
              agentId: "main",
              lifecycleGeneration: generation,
              projectSessionActive: true,
            },
            { ownsContext: true, trackOwner: true },
          );
          shortage = false;
          execution = withSessionPlacementTurnAdmission(
            { ...request, runId: nextRunId },
            { ...nextInput, preparedRunAdmission: nextAdmission },
            effect,
          ).catch((error: unknown) => error);
        }
        if (change === "cancel") {
          controller.abort(new Error("cancelled"));
        }
        if (change === "manual-pause") {
          await replaceSessionEntry(sessionTarget, {
            ...waiting,
            goal: { ...goal!, status: "paused" },
            goalPauseOrigin: "manual",
          });
        }
        if (change === "role") {
          await setCanonicalUserProfileRole(authority.profileId!, "revoked");
        }
        if (change === "placement") {
          await placements.startDispatch({
            ...request,
            expectedPlacement: {
              state: "failed",
              generation: placements.get(sessionId)!.generation,
              environmentId: placements.get(sessionId)!.environmentId,
              activeOwnerEpoch: null,
            },
          });
        }
        shortage = false;
        release.resolve();
        const result = await execution;
        if (change === "goal" || change === "accepted-no-goal") {
          if (result instanceof Error) {
            throw result;
          }
          expect(effects).toBe(1);
          expect(successfulAllocations).toBe(2); // retired predecessor and exactly one successor
          expect(new Set(operationIds).size).toBe(3); // predecessor, settled rejection, successor
          expect(loadSessionEntry(sessionTarget)?.mainRestartRecovery?.chargedAttempts).toBe(1);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(effects).toBe(0);
          expect(successfulAllocations).toBe(1);
        }
      } finally {
        controller.abort();
        release.resolve();
        await execution;
        uninstall();
        preparedRunAdmission.close();
        releaseAgentRunContext(runId, runContext);
        nextAdmission?.close();
        releaseAgentRunContext("provider-recovery-after-reopen", nextRunContext);
        operator?.release();
        await service.stop();
        projection.dispose();
      }
    },
  );
});

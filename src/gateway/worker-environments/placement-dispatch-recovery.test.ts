import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  type WorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { createWorkerPlacementDispatchStartup } from "./placement-dispatch-startup.js";
import {
  BUNDLE_HASH,
  MANIFEST_REF,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { canRedispatchFailedWorkerPlacement } from "./session-placement-lifecycle.js";
import type { WorkerTunnelManager } from "./tunnel.js";

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => support.testState.config,
}));

function createPlacementStore() {
  return createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => 1_000,
  });
}

describe("worker placement restart recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["confirmed", "pending", "default", "held", "retained VM"] as const)(
    "retires an ephemeral stale draining worker only after exact provider cleanup: %s",
    async (disposition) => {
      const placements = createPlacementStore();
      const environmentId = "ephemeral-lost-worker";
      await support.seedReadyNodeDesktop(environmentId);
      await support.testState.store.ensureNodeEnrollment(environmentId);
      const attached = await support.testState.store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: { ...support.attachedPatch(environmentId, REQUEST.sessionId), sharedHost: false },
      });
      if (disposition !== "default") {
        support.getDevelopmentProfile().lostWorkerRecovery = "repository-ref";
      }
      expect(attached.profileSnapshot).not.toHaveProperty("lostWorkerRecovery");
      const active = await seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      const draining = await placements.startDrain({
        sessionId: active.sessionId,
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        expectedGeneration: active.generation,
      });
      // Only external provider effects are synthetic; credential/placement custody is real SQLite.
      const destroy = vi.fn(async () => {
        if (disposition === "pending" || disposition === "held" || disposition === "retained VM") {
          throw new Error("Exact resource cleanup is unconfirmed");
        }
      });
      const hold = vi.fn(async () => ({
        status: "held" as const,
        leaseId: attached.leaseId!,
        unacceptedChanges: "unknown" as const,
        resources: [
          {
            kind: "vm",
            id: "/synthetic/old-vm",
            state: disposition === "retained VM" ? ("retained" as const) : ("absent" as const),
            immutableId: "observed-vm",
          },
          {
            kind: "disk",
            id: "/synthetic/old-disk",
            state: "retained" as const,
            immutableId: "observed-disk",
          },
        ],
      }));
      const environments = support.createService(
        support.createProvider({
          inspect: async () => ({ status: "unknown" }),
          destroy,
          ...(disposition === "held" || disposition === "retained VM"
            ? {
                resolveAllocation: async () => ({ leaseId: attached.leaseId!, sharedHost: false }),
                holdFailedLease: hold,
              }
            : {}),
        }),
        { placementStore: createWorkerSessionPlacementGate(placements) },
      );
      const recovery = createRecoveryService(placements, environments);
      await recovery.reconcileActive(environmentId);
      expect(destroy).toHaveBeenCalledOnce();
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      const observed = placements.get(REQUEST.sessionId)!;
      if (disposition === "held" || disposition === "retained VM") {
        expect(hold).toHaveBeenCalledOnce();
        expect(hold).toHaveBeenCalledWith(
          expect.objectContaining({
            operationId: "provision:ephemeral-lost-worker",
            leaseId: attached.leaseId,
            profile: attached.profileSnapshot.settings,
          }),
          expect.anything(),
        );
        expect(environments.get(environmentId)).toMatchObject({
          state: "orphaned",
          leaseId: attached.leaseId,
          recoveryHold: { phase: "held" },
        });
        if (observed.state !== "failed") {
          throw new Error("Expected fenced lost-worker placement");
        }
        expect(canRedispatchFailedWorkerPlacement(observed, environments.get(environmentId))).toBe(
          disposition === "held",
        );
      }
      if (disposition === "confirmed") {
        expect(environments.get(environmentId)).toMatchObject({ state: "failed", leaseId: null });
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          sessionId: REQUEST.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          state: "failed",
          recoveryError: "Ephemeral worker lost; recover from the recorded repository branch",
          turnClaim: null,
        });
      } else if (disposition === "default") {
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "draining",
          generation: draining.generation,
        });
      } else {
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "failed",
          turnClaim: null,
        });
        expect(environments.get(environmentId)?.state).not.toBe("destroyed");
      }
    },
  );

  describe.each(["startup", "active"] as const)("%s recovery after worker retirement", (mode) => {
    it.each(["idle", "claimed turn", "pending result", "provider loss"] as const)(
      "reclaims only a clean idle stale-build placement: %s",
      async (scenario) => {
        const placements = createPlacementStore();
        const harness = createHarness(support.testState.stateDb, placements, {
          workspacePath: support.testState.root,
        });
        const active = await harness.placements.seedActive(harness.attached.ownerEpoch);
        if (active.state !== "active") {
          throw new Error("retirement fixture did not produce an active placement");
        }
        const error =
          scenario === "provider loss" ? "provider lost worker" : STALE_WORKER_BUILD_REASON;
        vi.mocked(harness.environments.get).mockReturnValue({
          ...harness.attached,
          state: "failed",
          leaseId: null,
          sshEndpoint: null,
          bootstrapReceipt: null,
          sharedHost: null,
          tunnelStatus: "stopped",
          lastError: error,
          error,
        });
        if (scenario === "claimed turn" || scenario === "pending result") {
          const claim = await placements.claimTurn({
            ...REQUEST,
            claimId: "retirement-claim",
            runId: "retirement-run",
            owner: {
              kind: "worker",
              environmentId: active.environmentId,
              ownerEpoch: active.activeOwnerEpoch,
            },
          });
          if (scenario === "pending result") {
            await placements.markWorkspaceResultPending(claim);
            await placements.handoffWorkspaceResultRecovery(claim);
          }
        }

        if (mode === "startup") {
          await harness.service.reconcile("startup");
        } else {
          await harness.service.reconcileActive();
        }

        if (scenario === "idle") {
          expect(placements.get(REQUEST.sessionId)).toMatchObject({
            state: "reclaimed",
            terminalReason: null,
            recoveryError: null,
            turnClaim: null,
          });
          expect(harness.environments.destroy).not.toHaveBeenCalled();
        } else {
          const expectedError =
            scenario === "claimed turn" && mode === "startup"
              ? "Active worker turn claim cannot be proven live after gateway restart"
              : `cloud worker disappeared: ${error}`;
          expect(placements.get(REQUEST.sessionId)).toMatchObject({
            state: "failed",
            terminalReason: expectedError,
            recoveryError: expectedError,
            turnClaim: null,
          });
        }
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      },
    );
  });

  it.each(["startup", "active"] as const)(
    "does not report successful reclaim while provider-loss teardown is pending during %s recovery",
    async (mode) => {
      support.testState.prepareInstallation = vi.fn(async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      }));
      const destroy = vi.fn(async (): Promise<void> => {
        throw new Error("provider deletion unavailable");
      });
      const environments = support.createService(
        support.createProvider({ inspect: async () => ({ status: "unknown" }), destroy }),
      );
      const ready = await environments.createWithRequest({
        profileId: "development",
        idempotencyKey: "provider-loss-cleanup",
        executionMode: "remote-exec",
      });
      const attached = await environments.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      await seedActivePlacement(placements, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      const recovery = createRecoveryService(placements, environments);

      if (mode === "startup") {
        await recovery.reconcile("startup");
      } else {
        await recovery.reconcileActive(ready.environmentId);
      }

      expect.soft(destroy).toHaveBeenCalledOnce();
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "destroying",
        leaseId: ready.leaseId,
        destroyRequestedAtMs: support.testState.nowMs,
      });
      destroy.mockClear();
      await recovery.reconcileActive(ready.environmentId);
      expect.soft(destroy).toHaveBeenCalledOnce();

      destroy.mockClear();
      await expect(recovery.reclaim(REQUEST)).rejects.toThrow("provider deletion unavailable");
      expect(destroy).toHaveBeenCalledOnce();
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "failed",
        environmentId: ready.environmentId,
        recoveryError: expect.stringContaining("teardown failed"),
      });

      destroy.mockClear().mockResolvedValue(undefined);
      await expect(recovery.reclaim(REQUEST)).resolves.toMatchObject({ state: "local" });
      expect(destroy).toHaveBeenCalledOnce();
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
      });
    },
  );

  it.each(["startup", "active"] as const)(
    "fences a destroy-requested attachment during %s recovery even when physical cleanup fails",
    async (mode) => {
      const placements = createPlacementStore();
      const harness = createHarness(support.testState.stateDb, placements, { destroyFails: true });
      await harness.environments.attachSession({
        environmentId: harness.ready.environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const environment = {
        ...harness.attached,
        nodeDeviceId: "revoked-node",
        destroyRequestedAtMs: 1_000,
      };
      vi.mocked(harness.environments.get).mockReturnValue(environment);
      vi.mocked(harness.environments.stopTunnel).mockRejectedValue(
        new Error("node role revoked before stop confirmation"),
      );
      await harness.placements.seedActive(environment.ownerEpoch);

      if (mode === "startup") {
        await harness.service.reconcile("startup");
      } else {
        await harness.service.reconcileActive(environment.environmentId);
      }

      expect(harness.placements.current()).toMatchObject({
        state: "failed",
        environmentId: environment.environmentId,
        activeOwnerEpoch: environment.ownerEpoch,
        recoveryError: expect.stringContaining("node role revoked before stop confirmation"),
      });
      expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
      expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      failure: "provider no longer supports the persisted execution mode",
      executionMode: "remote-exec",
      snapshotMode: "remote-exec",
      nodeBacked: true,
      providerSupportsMode: false,
      expectedError: "does not support remote-exec",
      sweep: false,
    },
    {
      failure: "persisted provisioning mode does not match placement authority",
      executionMode: "remote-exec",
      snapshotMode: "worker-turn",
      nodeBacked: true,
      providerSupportsMode: true,
      expectedError: "execution mode does not match",
      sweep: false,
    },
    {
      failure: "worker-turn placement has an SSH lease",
      executionMode: "worker-turn",
      snapshotMode: "worker-turn",
      nodeBacked: false,
      providerSupportsMode: true,
      expectedError: "requires a node lease",
      sweep: false,
    },
    {
      failure: "runtime sweep observes a changed provider execution mode",
      executionMode: "remote-exec",
      snapshotMode: "remote-exec",
      nodeBacked: true,
      providerSupportsMode: false,
      expectedError: "does not support remote-exec",
      sweep: true,
    },
  ] as const)("fences active restart recovery when $failure", async (scenario) => {
    const placements = createPlacementStore();
    const harness = createHarness(support.testState.stateDb, placements);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    const environment = {
      ...harness.attached,
      providerId: "durable-provider",
      profileSnapshot: {
        ...harness.attached.profileSnapshot,
        executionMode: scenario.snapshotMode,
      },
      ...(scenario.nodeBacked ? { nodeDeviceId: "durable-node", sshEndpoint: null } : {}),
    };
    vi.mocked(harness.environments.get).mockReturnValue(environment);
    vi.mocked(harness.environments.supportsProviderExecutionMode).mockReturnValue(
      scenario.providerSupportsMode,
    );
    await harness.placements.seedActive(environment.ownerEpoch, scenario.executionMode);

    if (scenario.sweep) {
      await harness.service.reconcileActive(environment.environmentId);
    } else {
      await harness.service.reconcile();
    }

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(scenario.expectedError),
    });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
    expect(harness.log).not.toContain("placement:adopted");
  });

  it.each([
    { transport: "node", nodeBacked: true },
    { transport: "SSH", nodeBacked: false },
  ] as const)(
    "adopts an exact remote-exec $transport lease from its durable provider after profile changes",
    async ({ nodeBacked }) => {
      const placements = createPlacementStore();
      const harness = createHarness(support.testState.stateDb, placements);
      await harness.environments.attachSession({
        environmentId: harness.ready.environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const environment = {
        ...harness.attached,
        providerId: "durable-provider",
        profileSnapshot: {
          ...harness.attached.profileSnapshot,
          executionMode: "remote-exec" as const,
        },
        ...(nodeBacked ? { nodeDeviceId: "durable-node", sshEndpoint: null } : {}),
      };
      vi.mocked(harness.environments.get).mockReturnValue(environment);
      const supportsProviderExecutionMode = vi.mocked(
        harness.environments.supportsProviderExecutionMode,
      );
      await harness.placements.seedActive(environment.ownerEpoch, "remote-exec");

      await harness.service.reconcile();

      expect(harness.placements.current()).toMatchObject({
        state: "active",
        executionMode: "remote-exec",
      });
      expect(supportsProviderExecutionMode).toHaveBeenCalledWith("durable-provider", "remote-exec");
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      if (nodeBacked) {
        expect(harness.environments.startTunnel).not.toHaveBeenCalled();
      } else {
        expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { creation: "profile", matchingEnvironmentExists: true },
    { creation: "inherited", matchingEnvironmentExists: true },
    { creation: "profile", matchingEnvironmentExists: false },
  ] as const)(
    "never tears down an unrelated environment returned by $creation creation (expected owner exists: $matchingEnvironmentExists)",
    async ({ creation, matchingEnvironmentExists }) => {
      const placements = createPlacementStore();
      const harness = createHarness(support.testState.stateDb, placements);
      const unrelatedEnvironment = {
        ...harness.attached,
        environmentId: "worker-unrelated-active",
        ownerEpoch: 91,
        attachedSessionIds: ["session-unrelated"],
      };
      vi.mocked(harness.environments.createWithRequest).mockResolvedValue(unrelatedEnvironment);
      vi.mocked(harness.environments.get).mockImplementation((environmentId) => {
        if (environmentId === unrelatedEnvironment.environmentId) {
          return unrelatedEnvironment;
        }
        return matchingEnvironmentExists && environmentId === harness.ready.environmentId
          ? harness.ready
          : undefined;
      });
      const request =
        creation === "inherited"
          ? {
              ...REQUEST,
              inheritedProfile: {
                providerId: "fake",
                profileSnapshot: { install: "bundle" as const, settings: { region: "parent" } },
              },
            }
          : REQUEST;

      await expect(harness.service.dispatch(request)).rejects.toThrow(
        "current worker launch contract",
      );

      expect(harness.placements.current()).toMatchObject({
        state: "failed",
        environmentId: harness.ready.environmentId,
      });
      expect(harness.environments.attachSession).not.toHaveBeenCalled();
      expect(harness.environments.stopTunnel).not.toHaveBeenCalledWith(
        unrelatedEnvironment.environmentId,
        expect.anything(),
      );
      expect(harness.environments.destroy).not.toHaveBeenCalledWith(
        unrelatedEnvironment.environmentId,
      );
      if (matchingEnvironmentExists) {
        expect(harness.environments.stopTunnel).toHaveBeenCalledWith(
          harness.ready.environmentId,
          harness.ready.ownerEpoch,
        );
        expect(harness.environments.destroy).toHaveBeenCalledWith(harness.ready.environmentId);
      } else {
        expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      }
    },
  );

  it("resumes an authoritative provisioning placement through the canonical dispatch stages", async () => {
    const placements = createPlacementStore();
    const harness = createHarness(support.testState.stateDb, placements);
    const provisioning = await harness.placements.seedProvisioning();
    if (provisioning.state !== "provisioning") {
      throw new Error("recovery fixture did not produce a provisioning placement");
    }
    harness.log.length = 0;

    await harness.service.resumeProvisioning(provisioning, async () => {
      harness.log.push("environment:reconcile");
    });

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
      workerBundleHash: harness.ready.bootstrapReceipt?.bundleHash,
    });
    expect(harness.placements.current()!.generation).toBeGreaterThan(provisioning.generation);
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(harness.environments.attachSession).toHaveBeenCalledOnce();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("recovery-barrier");
    expect(harness.log).toContain("placement:syncing");
    expect(harness.log).toContain("placement:starting");
    expect(harness.log).toContain("placement:active");
    expect(harness.log).not.toContain("activation");
  });

  it("fences provisioning recovery before attachment when its durable execution mode differs", async () => {
    const placements = createPlacementStore();
    const harness = createHarness(support.testState.stateDb, placements);
    const provisioning = await harness.placements.seedProvisioning("remote-exec");
    if (provisioning.state !== "provisioning") {
      throw new Error("recovery fixture did not produce a provisioning placement");
    }
    const environment = {
      ...harness.ready,
      profileSnapshot: { ...harness.ready.profileSnapshot, executionMode: "worker-turn" as const },
    };
    vi.mocked(harness.environments.get).mockReturnValue(environment);

    await harness.service.resumeProvisioning(provisioning, async () => {});

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("execution mode"),
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
  });

  it("fails a placement interrupted before its environment intent and permits redispatch", async () => {
    const placements = createPlacementStore();
    const harness = createHarness(support.testState.stateDb, placements);
    const provisioning = await harness.placements.seedProvisioning();
    vi.mocked(harness.environments.get).mockReturnValue(undefined);

    await harness.service.reconcile();

    const failed = harness.placements.current();
    expect(failed).toMatchObject({
      state: "failed",
      environmentId: provisioning.environmentId,
      recoveryError: expect.stringContaining("environment"),
    });
    expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    if (failed?.state !== "failed") {
      throw new Error("restart recovery did not fail the interrupted provisioning placement");
    }

    const redispatch = createHarness(support.testState.stateDb, placements, {
      environmentGeneration: failed.generation + 1,
    });
    const active = await redispatch.service.dispatch(REQUEST);

    expect(active).toMatchObject({
      state: "active",
      environmentId: redispatch.ready.environmentId,
    });
    expect(active.environmentId).not.toBe(provisioning.environmentId);
  });

  it.each(["requested", "provisioning", "bootstrapping", "ready", "idle"] as const)(
    "retains an exact replayable %s environment during provisioning recovery",
    async (state) => {
      const placements = createPlacementStore();
      const harness = createHarness(support.testState.stateDb, placements);
      const provisioning = await harness.placements.seedProvisioning();
      const environment =
        state === "requested" || state === "provisioning"
          ? {
              ...harness.ready,
              state,
              leaseId: null,
              sshEndpoint: null,
              bootstrapReceipt: null,
              sharedHost: null,
              tunnelStatus: "stopped" as const,
            }
          : state === "bootstrapping"
            ? { ...harness.ready, state, bootstrapReceipt: null }
            : { ...harness.ready, state };
      vi.mocked(harness.environments.get).mockReturnValue(environment);

      await harness.service.reconcile();

      expect(harness.placements.current()).toEqual(provisioning);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["destroy-requested", { destroyRequestedAtMs: 1_000 }],
    ["attached", { state: "attached" as const, attachedSessionIds: Array.of(REQUEST.sessionId) }],
    ["draining", { state: "draining" as const }],
    ["destroying", { state: "destroying" as const }],
    ["destroyed", { state: "destroyed" as const }],
    ["failed", { state: "failed" as const }],
    ["orphaned", { state: "orphaned" as const }],
    ["mismatched", { environmentId: "worker-different" }],
    ["missing receipt", { bootstrapReceipt: null }],
    [
      "legacy launch dialect",
      {
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.7.2",
          protocolFeatures: Array.of(WORKER_LAUNCH_V2_PROTOCOL_FEATURE),
        },
      },
    ],
  ] as const)("fails provisioning recovery for a %s environment", async (_kind, patch) => {
    const placements = createPlacementStore();
    const harness = createHarness(support.testState.stateDb, placements);
    await harness.placements.seedProvisioning();
    const environment =
      "state" in patch && patch.state === "failed"
        ? {
            ...harness.ready,
            ...patch,
            leaseId: null,
            sshEndpoint: null,
            bootstrapReceipt: null,
            sharedHost: null,
            tunnelStatus: "stopped" as const,
          }
        : { ...harness.ready, ...patch };
    vi.mocked(harness.environments.get).mockReturnValue(environment);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("tears down provisioning when the recovery authority barrier rejects", async () => {
    const message = "Session agent:main:session-1 changed before cloud worker recovery";
    const placements = createPlacementStore();
    const harness = createHarness(support.testState.stateDb, placements, {
      recoveryBarrierError: new Error(message),
    });
    const provisioning = await harness.placements.seedProvisioning();
    if (provisioning.state !== "provisioning") {
      throw new Error("recovery fixture did not produce a provisioning placement");
    }

    await harness.service.resumeProvisioning(provisioning, async () => {});

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: message,
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { timing: "before", change: "generation", state: "provisioning" },
    { timing: "before", change: "environment", state: "provisioning" },
    { timing: "before", change: "environment", state: "syncing" },
    { timing: "before", change: "environment", state: "starting" },
    { timing: "before", change: "session", state: "provisioning" },
    { timing: "after", change: "generation", state: "provisioning" },
    { timing: "after", change: "environment", state: "provisioning" },
    { timing: "after", change: "environment", state: "syncing" },
    { timing: "after", change: "environment", state: "starting" },
    { timing: "after", change: "session", state: "provisioning" },
  ] as const)(
    "never tears down a newer $state $change owner when recovery fails $timing its callback",
    async ({ change, state, timing }) => {
      const placements = createPlacementStore();
      const harness = createHarness(support.testState.stateDb, placements);
      const original = await harness.placements.seedProvisioning();
      if (original.state !== "provisioning" || !original.environmentId) {
        throw new Error("recovery fixture did not produce an owned provisioning placement");
      }
      const replacementEnvironmentId =
        change === "environment" ? "worker-newer-environment" : original.environmentId;
      const pendingEnvironment = {
        ...harness.ready,
        state: "provisioning" as const,
        leaseId: null,
        sshEndpoint: null,
        bootstrapReceipt: null,
        sharedHost: null,
        tunnelStatus: "stopped" as const,
      };
      vi.mocked(harness.environments.get).mockImplementation((environmentId) =>
        environmentId === original.environmentId
          ? pendingEnvironment
          : environmentId === replacementEnvironmentId
            ? { ...harness.ready, environmentId }
            : undefined,
      );
      let replacement: ReturnType<typeof placements.get>;
      const observedPlacements = {
        ...placements,
        get: (sessionId: string) => {
          const current = placements.get(sessionId);
          return change === "session" && replacement && current
            ? { ...current, sessionKey: "agent:main:replacement-session" }
            : current;
        },
      };
      const replacePlacement = async () => {
        await placements.fail({
          sessionId: original.sessionId,
          expectedGeneration: original.generation,
          recoveryError: "superseded placement",
        });
        const requested = await placements.startDispatch(REQUEST);
        replacement = await placements.transition({
          sessionId: original.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: replacementEnvironmentId },
        });
        if (state === "syncing" || state === "starting") {
          replacement = await placements.transition({
            sessionId: original.sessionId,
            from: "provisioning",
            to: "syncing",
            expectedGeneration: replacement.generation,
            patch: { workerBundleHash: BUNDLE_HASH },
          });
        }
        if (state === "starting") {
          replacement = await placements.transition({
            sessionId: original.sessionId,
            from: "syncing",
            to: "starting",
            expectedGeneration: replacement.generation,
            patch: {
              workspaceBaseManifestRef: MANIFEST_REF,
              remoteWorkspaceDir: "/worker/newer-workspace",
            },
          });
        }
      };
      const startup = createWorkerPlacementDispatchStartup({
        placements: observedPlacements,
        environments: harness.environments,
        failure: createPlacementFailureActions({
          placements: observedPlacements,
          environments: harness.environments,
        }),
        runRecoveryBarrier: async ({ run }) => {
          if (timing === "after") {
            await run({ kind: "local", path: "/gateway/workspace" });
          }
          await replacePlacement();
          throw new Error("stale recovery lifecycle was replaced");
        },
        runActivationBarrier: async ({ activate }) => activate(),
      });

      await startup.resumeProvisioning(original, async () => {});

      expect(placements.get(original.sessionId)).toEqual(replacement);
      expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["attach", "tunnel:attached", "sync"] as const)(
    "tears down only its exact owned placement when recovery fails during %s",
    async (failAt) => {
      const placements = createPlacementStore();
      const harness = createHarness(support.testState.stateDb, placements, { failAt });
      const provisioning = await harness.placements.seedProvisioning();
      if (provisioning.state !== "provisioning") {
        throw new Error("recovery fixture did not produce a provisioning placement");
      }

      await harness.service.resumeProvisioning(provisioning, async () => {});

      expect(harness.placements.current()).toMatchObject({
        state: "failed",
        environmentId: provisioning.environmentId,
        recoveryError: expect.stringContaining("failed"),
      });
      expect(harness.environments.destroy).toHaveBeenCalledWith(provisioning.environmentId);
    },
  );

  it("does not recover a pending result through a worker with the legacy launch dialect", async () => {
    const placements = createPlacementStore();
    const originalHarness = createHarness(support.testState.stateDb, placements);
    const active = await originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = await placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "legacy-worker-claim",
      runId: "legacy-worker-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await placements.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 2_000,
    });
    const restartedHarness = createHarness(support.testState.stateDb, restartedStore);
    restartedHarness.markEnvironmentOwnerEpoch(2);
    restartedHarness.markEnvironmentProtocolFeatures([WORKER_LAUNCH_V2_PROTOCOL_FEATURE]);

    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Pending cloud workspace result lost its worker: session-1",
    });
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(restartedHarness.environments.startTunnel).not.toHaveBeenCalled();
  });

  it("does not adopt an active worker missing exec-authority launch support", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(support.testState.stateDb, placements);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: "session-1",
    });
    await harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentProtocolFeatures([WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE]);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each(["bundle", "provider"] as const)(
    "keeps stale pending recovery fenced when %s recovery is unavailable",
    async (failure) => {
      const currentReceipt: WorkerAdmissionHandshake = {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [
          WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
          WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
        ],
      };
      let currentBundle: WorkerInstallationArtifact = {
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: currentReceipt.protocolFeatures,
      };
      const recoveryState = { started: false };
      support.testState.prepareInstallation = vi.fn(async (install) => {
        if (install === "bundle" && recoveryState.started && failure === "bundle") {
          throw new Error("bundle unavailable");
        }
        return install === "bundle" ? currentBundle : support.NPM_ARTIFACT;
      });
      const tunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const provider = support.createProvider({
        inspect: async () => {
          if (recoveryState.started && failure === "provider") {
            throw new Error("provider unavailable");
          }
          return { status: "active" };
        },
      });
      const workerService = support.createService(provider, { tunnelManager });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      const recovery = createRecoveryService(placements, workerService);
      const environmentId = "worker-stale-recovery";
      const bootstrapping = await support.seedBootstrapping(environmentId);
      await support.testState.store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: support.readyPatch(environmentId, currentReceipt),
      });
      const attached = await workerService.attachSession({
        environmentId,
        ownerEpoch: 1,
        sessionId: "session-1",
      });
      const active = await seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = await placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "claim-stale-recovery",
        runId: "run-stale-recovery",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      await placements.markWorkspaceResultPending(claim);
      await placements.handoffWorkspaceResultRecovery(claim);
      currentBundle = { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) };
      recoveryState.started = true;

      await recovery.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        turnClaim: { claimId: claim.claimId, runId: claim.runId },
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      expect(workerService.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      expect(tunnelManager.start).not.toHaveBeenCalled();
    },
  );
});

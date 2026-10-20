import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WorkerProviderError, type WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  beforeSettlement,
  create,
  pendingNodeEnrollment,
  providerService,
} from "./provider-lifecycle.test-support.js";
import {
  bindProviderReplayNodeAvailability,
  createProviderReplayDispatch,
  createProviderReplayNodeTunnel,
} from "./provider-replay.test-support.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
const protocolFeatures = [
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
];
const ensureNodeWorkerBundle = async () => ({
  ...support.BOOTSTRAP_RECEIPT,
  protocolFeatures: [...protocolFeatures],
});
const invalidSshLease = (patch: object) => ({
  leaseId: "lease-invalid",
  ssh: support.SSH_ENDPOINT,
  ...patch,
});
const providerFailure = {
  code: "provider_failure",
} satisfies Partial<WorkerEnvironmentServiceError>;
const pendingAllocation = { state: "provisioning", leaseId: null };

describe("worker environment service provision replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("retains an indeterminate node lease when runtime preflight fails after restart", async () => {
    const provision = vi.fn<WorkerProvider["provision"]>(async () => {
      throw new Error("node allocation response was lost");
    });
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      provision,
      destroy,
    });
    const enrollment = async () => {
      throw new Error("enrollment must not run");
    };
    const first = support.createService(provider, { prepareNodeEnrollment: enrollment });
    await expect(create(first, "preflight-replay")).rejects.toMatchObject(providerFailure);
    const original = support.testState.store.list()[0]!;
    expect(original.state).toBe("provisioning");
    await support.reopenWorkerEnvironmentStore();
    const restarted = support.createService(provider, {
      prepareNodeEnrollment: enrollment,
      prepareNodeBootstrap: async () => {
        throw new Error("runtime preparation unavailable");
      },
    });
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(original.environmentId)?.lastError).toContain(
        "runtime preparation unavailable",
      ),
    );
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      ...pendingAllocation,
      provisionOperationId: original.provisionOperationId,
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await expect(restarted.destroy(original.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("adopts one committed provision across a service and store restart", async () => {
    const physicalLeases = new Set<string>();
    const operationIds: string[] = [];
    const machineClasses: Array<string | undefined> = [];
    const operatingSystems: Array<string | undefined> = [];
    const destroyed: string[] = [];
    let creates = 0;
    let loseFirstReply = true;
    const provider = () =>
      support.createProvider({
        provision: async (_profile, operationId, options) => {
          operationIds.push(operationId);
          machineClasses.push(options?.machineClass);
          operatingSystems.push(options?.os);
          if (!physicalLeases.has("lease-restarted")) {
            creates += 1;
            physicalLeases.add("lease-restarted");
          }
          if (loseFirstReply) {
            loseFirstReply = false;
            throw new Error("provider response was lost after commit");
          }
          return { leaseId: "lease-restarted", ssh: support.SSH_ENDPOINT };
        },
        destroy: async ({ leaseId }) => {
          destroyed.push(leaseId);
          physicalLeases.delete(leaseId);
        },
      });
    const first = support.createService(provider());

    await expect(
      first.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-restart-replay",
        machineClass: "large",
        os: "os-a",
      }),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = expectDefined(
      support.testState.store.list()[0],
      "persisted provision intent",
    ).environmentId;
    const operationId = expectDefined(
      support.testState.store.get(environmentId),
      "persisted provision record",
    ).provisionOperationId;
    expect(operationId).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });

    await support.reopenWorkerEnvironmentStore();

    const restarted = support.createService(provider());
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "ready",
        leaseId: "lease-restarted",
        lastError: null,
      }),
    );
    await restarted.destroy(environmentId);

    expect(creates).toBe(1);
    expect(operationIds).toEqual([operationId, operationId]);
    expect(machineClasses).toEqual(["large", "large"]);
    expect(operatingSystems).toEqual(["os-a", "os-a"]);
    expect(destroyed).toEqual(["lease-restarted"]);
    expect(physicalLeases.size).toBe(0);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: "lease-restarted",
    });
  });

  it("replays one node lease once across overlapping reconciliation and activates once", async () => {
    const enrollmentStarted = createDeferredCore();
    const operationIds: string[] = [];
    const physicalLeases = new Set<string>();
    const enrollmentConnected = createDeferredCore<string>();
    const destroy = vi.fn(async ({ leaseId }: { leaseId: string }) => {
      physicalLeases.delete(leaseId);
    });
    let provisionCalls = 0;
    let physicalAllocations = 0;
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      provisionBeforeInstallation: true,
      requiresNodeEnrollment: true,
      provision: async (_profile, operationId, options) => {
        provisionCalls += 1;
        operationIds.push(operationId);
        if (!physicalLeases.has("lease-node-replay")) {
          physicalLeases.add("lease-node-replay");
          physicalAllocations += 1;
        }
        if (provisionCalls === 1) {
          throw new Error("provider response was lost after exact lease allocation");
        }
        const enrollment = await options?.beginNodeEnrollment?.();
        if (!enrollment) {
          throw new Error("node enrollment was not prepared");
        }
        enrollmentStarted.resolve();
        return {
          leaseId: "lease-node-replay",
          node: { deviceId: await enrollment.waitForDeviceId() },
          sharedHost: false,
        };
      },
      destroy,
    });
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: [...protocolFeatures],
    }));
    const placementStore = () =>
      createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
    let placements = placementStore();
    const placement = await placements.startDispatch(REQUEST);
    const idempotencyKey = `session-dispatch:${REQUEST.sessionId}:${placement.generation}`;
    const intent = deriveEnvironmentIntent(idempotencyKey);
    await placements.transition({
      sessionId: placement.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: intent.environmentId },
    });
    const first = support.createService(provider, {
      ensureNodeWorkerBundle,
      prepareNodeEnrollment: async () => {
        throw new Error("first provision reply was lost before node enrollment");
      },
    });

    await expect(
      create(first, idempotencyKey, { executionMode: REQUEST.executionMode }),
    ).rejects.toMatchObject(providerFailure);
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      ...pendingAllocation,
      provisionOperationId: intent.provisionOperationId,
    });

    await support.reopenWorkerEnvironmentStore();
    placements = placementStore();
    const { nodeTunnelManager, syncWorkspace } = createProviderReplayNodeTunnel();
    const restarted = support.createService(provider, {
      ensureNodeWorkerBundle,
      prepareNodeEnrollment: (record) =>
        pendingNodeEnrollment(record, () => enrollmentConnected.promise, "2026.8.19"),
      nodeTunnelManager,
    });
    bindProviderReplayNodeAvailability(restarted);
    const recoveryBarrier = vi.fn(async ({ expectedGeneration, environmentId, run }) => {
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "provisioning",
        generation: expectedGeneration,
        environmentId,
      });
      await run({ kind: "local", path: "/gateway/workspace" });
    });
    const activationBarrier = vi.fn(async ({ activate }) => activate());
    const onActivated = vi.fn();
    const attachSession = vi.spyOn(restarted, "attachSession");
    const dispatch = createProviderReplayDispatch({
      initialPlacements: await placements.listAsync(),
      placements,
      environments: restarted,
      resolveDevicePlacementRequirement: async () => ({
        requiredNodeCommands: [],
        consumesWorkerSlot: true,
      }),
      isCurrentNodePlacement: () => true,
      runRecoveryBarrier: recoveryBarrier,
      runActivationBarrier: activationBarrier,
      onActivated,
    });
    const uninstallReconcileGuard = restarted.installReconcileEnvironmentGuard(
      async (environmentId, reconcileEnvironmentCore) => {
        const owners = (await placements.listAsync()).filter(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (owners.length !== 1 || owners[0]?.state !== "provisioning") {
          await reconcileEnvironmentCore();
          return;
        }
        await dispatch.resumeProvisioning(owners[0], reconcileEnvironmentCore);
      },
    );

    let recoverySettled = false;
    const recovery = dispatch.reconcile().finally(() => {
      recoverySettled = true;
    });
    await beforeSettlement(enrollmentStarted.promise, recovery, "Recovery enrollment");
    expect(recoverySettled).toBe(false);
    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "provisioning",
      environmentId: intent.environmentId,
    });
    expect(support.testState.store.get(intent.environmentId)).toMatchObject(pendingAllocation);
    expect(nodeTunnelManager.start).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    const overlappingEnvironmentReconcile = restarted.reconcileEnvironment(intent.environmentId);
    const overlappingPlacementReconcile = dispatch.reconcileActive(intent.environmentId);
    await Promise.resolve();
    expect(provisionCalls).toBe(2);

    enrollmentConnected.resolve("device-node-replay");
    await Promise.all([recovery, overlappingEnvironmentReconcile, overlappingPlacementReconcile]);
    await uninstallReconcileGuard();

    const activePlacement = placements.get(REQUEST.sessionId);
    expect(activePlacement).toMatchObject({
      state: "active",
      environmentId: intent.environmentId,
      workerBundleHash: support.BUNDLE_HASH,
    });
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "attached",
      leaseId: "lease-node-replay",
      nodeDeviceId: "device-node-replay",
      attachedSessionIds: [REQUEST.sessionId],
    });
    expect(physicalAllocations).toBe(1);
    expect(operationIds).toEqual([intent.provisionOperationId, intent.provisionOperationId]);
    expect(recoveryBarrier).toHaveBeenCalled();
    expect(activationBarrier).not.toHaveBeenCalled();
    for (const effect of [attachSession, nodeTunnelManager.start, syncWorkspace, onActivated]) {
      expect(effect).toHaveBeenCalledOnce();
    }
    expect(onActivated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: REQUEST.sessionId }),
      activePlacement,
    );
    expect(destroy).not.toHaveBeenCalled();
  });

  it("recovers indeterminate cleanup with bounded, redacted diagnostics", async () => {
    const leaseId = "lease:worker-provision-cleanup";
    const provisionDiagnosis = "worker enrollment failed: tar: Unexpected EOF in archive";
    const cleanupDiagnosis = "provider stop timed out after release was requested";
    const secret = `synthetic-worker-auth-${"x".repeat(48)}`;
    const progress = String.fromCodePoint(0x1f9ea).repeat(200);
    const provisionDetail = `Crabbox worker bootstrap failed with exit code 1: ... ${progress} --provider aws --type worker\nAuthorization: Bearer ${secret}\n${provisionDiagnosis}`;
    const cleanupDetail = `Crabbox stop did not exit normally (timeout): ... ${progress} --provider aws --type worker\nAuthorization: Bearer ${secret}\n${cleanupDiagnosis}`;
    const provision = vi.fn(async () => {
      throw WorkerProviderError.cleanupIndeterminate(
        leaseId,
        new Error(provisionDetail),
        new Error(cleanupDetail),
      );
    });
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({ provision, inspect, destroy });
    const workerService = support.createService(provider);

    const failure = await create(workerService, "request-provision-cleanup").catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject(providerFailure);
    if (!(failure instanceof Error)) {
      throw new Error("expected worker creation to fail");
    }
    const pending = expectDefined(support.testState.store.list()[0], "persisted provision cleanup");
    const diagnostic = expectDefined(pending.lastError, "persisted cleanup diagnostic");
    for (const detail of [failure.message, diagnostic]) {
      expect(detail).toContain(provisionDiagnosis);
      expect(detail).toContain(cleanupDiagnosis);
      expect(detail).not.toContain(secret);
      expect(detail).not.toContain("x".repeat(40));
      expect(detail).not.toMatch(/\s{2,}/u);
      expect(Buffer.from(detail, "utf8").toString("utf8")).toBe(detail);
      expect(detail).toContain("Crabbox worker bootstrap failed with exit code 1");
      expect(detail).toContain("Crabbox stop did not exit normally (timeout)");
    }
    expect(diagnostic.length).toBeLessThanOrEqual(1_024);
    expect(failure.message).toBe(
      `Worker provider operation failed; teardown is pending: ${diagnostic}`,
    );
    expect(pending).toMatchObject({
      state: "destroying",
      leaseId,
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
      lastError: diagnostic,
    });

    await support.reopenWorkerEnvironmentStore();
    const restarted = support.createService(provider);
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
      }),
    );

    expect(provision).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId, profile: { region: "test" } }),
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
    expect(support.testState.store.get(pending.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      teardownTerminalState: "failed",
      lastError: diagnostic,
    });
  });

  it("rejects a timer-overflow provider provision timeout before allocation", async () => {
    const timeoutMs = MAX_TIMER_TIMEOUT_MS + 1;
    const provision = vi.fn(async () => ({
      leaseId: "lease-invalid-timeout",
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = providerService({
      provision,
      resolveProvisionTimeoutMs: () => timeoutMs,
    });

    await expect(
      create(workerService, `request-invalid-provider-timeout-${String(timeoutMs)}`),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("Worker provider provision timeout must be an integer"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("does not invoke a late prepared allocation after replay times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    const lateAllocation = vi.fn(async () => ({ leaseId: "lease-1", ssh: support.SSH_ENDPOINT }));
    let preparations = 0;
    const service = providerService(
      {
        prepareProvision: async () => {
          if (++preparations === 1) {
            return async () => {
              throw new Error("synthetic response lost after allocation");
            };
          }
          entered.resolve();
          await settled.promise;
          return lateAllocation;
        },
      },
      { providerCallTimeoutMs: 25 },
    );
    await expect(create(service, "replayed-preparation")).rejects.toThrow(
      "response lost after allocation",
    );
    const replay = create(service, "replayed-preparation").catch((error: unknown) => error);
    try {
      await beforeSettlement(entered.promise, replay, "Replay preparation");
      await vi.advanceTimersByTimeAsync(25);
      expect(await replay).toMatchObject(providerFailure);
      expect(support.testState.store.list()[0]).toMatchObject(pendingAllocation);
    } finally {
      settled.resolve();
      await replay;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(lateAllocation).not.toHaveBeenCalled();
    expect(support.testState.store.list()[0]).toMatchObject(pendingAllocation);
  });

  it("serializes allocation resolution and destroy behind a timed-out provider operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const provisionEntered = createDeferredCore();
    const intentCommitted = createDeferredCore();
    const requestDestroy = support.testState.store.requestDestroy.bind(support.testState.store);
    vi.spyOn(support.testState.store, "requestDestroy").mockImplementation(async (input) => {
      const record = await requestDestroy(input);
      intentCommitted.resolve();
      return record;
    });
    const events: string[] = [];
    const operationIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    let originalProvisionCalls = 0;
    const { promise: firstProvisionPending, resolve: finishFirstProvision } = createDeferredCore();
    const destroy = vi.fn(async () => {
      events.push("destroy:start");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push("destroy:end");
    });
    const provider = support.createProvider({
      resolveAllocation: async () => {
        events.push("resolve");
        expect(active).toBe(0);
        return { leaseId: "lease-timeout-replay", sharedHost: false };
      },
      provision: async (_profile, operationId) => {
        originalProvisionCalls += 1;
        const call = originalProvisionCalls;
        operationIds.push(operationId);
        events.push(`provision:${call}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          provisionEntered.resolve();
          await firstProvisionPending;
        }
        active -= 1;
        events.push(`provision:${call}:end`);
        return { leaseId: "lease-timeout-replay", ssh: support.SSH_ENDPOINT };
      },
      destroy,
      resolveProvisionTimeoutMs: () => 20,
    });
    const workerService = support.createService(provider);
    const creation = create(workerService, "request-provider-timeout-race");
    const creationResult = creation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let environmentId: string | undefined;
    let teardownResult: Promise<unknown> | undefined;
    try {
      await beforeSettlement(provisionEntered.promise, creationResult, "Creation provider call");
      expect(events).toEqual(["provision:1:start"]);
      const queuedEnvironmentId = expectDefined(
        support.testState.store.list()[0],
        "timed-out provision row",
      ).environmentId;
      environmentId = queuedEnvironmentId;
      teardownResult = workerService.destroy(queuedEnvironmentId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(20);
      expect(await creationResult).toMatchObject({ error: providerFailure });
      await beforeSettlement(intentCommitted.promise, teardownResult, "Teardown intent commit");
      expect(originalProvisionCalls).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
    } finally {
      finishFirstProvision();
      await Promise.all([creationResult, teardownResult]);
    }

    expect(await teardownResult).toMatchObject({ value: { state: "destroyed" } });
    const finalEnvironmentId = expectDefined(environmentId, "timed-out provision environment id");
    expect(operationIds).toHaveLength(1);
    expect(new Set(operationIds).size).toBe(1);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "provision:1:start",
      "provision:1:end",
      "resolve",
      "destroy:start",
      "destroy:end",
    ]);
    expect(support.testState.store.get(finalEnvironmentId)).toMatchObject({ state: "destroyed" });
  });

  it.each([
    [{ leaseId: "lease-invalid", node: { deviceId: " " } }, "invalid node device id"],
    [
      invalidSshLease({ ssh: { ...support.SSH_ENDPOINT, keyRef: "not-a-secret-ref" } }),
      "SSH key must be a valid SecretRef",
    ],
    [invalidSshLease({ sharedHost: "yes" }), "invalid provision result"],
    [
      invalidSshLease({ desktop: { protocol: "rdp", port: 5900 } }),
      'desktop protocol must be "rfb"',
    ],
    [invalidSshLease({ desktop: { protocol: "rfb", port: 0 } }), "desktop port must be an integer"],
    [
      invalidSshLease({
        desktop: { protocol: "rfb", port: 5900, passwordFilePath: "vnc.password" },
      }),
      "desktop password file path must be absolute",
    ],
  ])("keeps provider result %j retryable (%s)", async (result, error) => {
    const workerService = providerService({ provision: async () => result as never });

    await expect(create(workerService, "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining(error),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });

  it("adopts an indeterminate allocation before a replay preparation failure", async () => {
    const events: string[] = [];
    let preparationFails = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      events.push("prepare");
      if (preparationFails) {
        throw new Error("persisted bundle is unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    let provisionCalls = 0;
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        events.push("provision");
        provisionCalls += 1;
        operationIds.push(operationId);
        if (provisionCalls === 1) {
          throw new Error("provision response was lost");
        }
        return { leaseId: "lease-replayed", ssh: support.SSH_ENDPOINT };
      },
      destroy: async () => void events.push("destroy"),
    });
    const workerService = support.createService(provider);

    await expect(create(workerService, "request-lost-provision")).rejects.toMatchObject(
      providerFailure,
    );
    preparationFails = true;
    await workerService.reconcileOnce();

    expect(events).toEqual(["prepare", "provision", "provision", "prepare", "destroy"]);
    expect(new Set(operationIds).size).toBe(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "persisted bundle is unavailable",
    });
  });
});

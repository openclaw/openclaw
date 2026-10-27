import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { tryBeginGatewaySuspendAdmission } from "../../process/gateway-work-admission.js";
import { create, providerService as service } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";
import { testState } from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;
type Transition = Parameters<typeof testState.store.transition>[0];
type Environment = NonNullable<ReturnType<typeof testState.store.get>>;

const fail = (message: string) => async () => {
  throw new Error(message);
};
const lifecycleLease = (leaseId: string) => ({
  leaseId,
  profile: { region: "test" },
  signal: expect.any(AbortSignal),
});

function expectState(
  environmentId: string,
  state: Environment["state"],
  fields: Partial<Environment> = {},
) {
  expect(testState.store.get(environmentId)).toMatchObject({ state, ...fields });
}

async function seedStale(environmentId: string, bundleHash: string, install?: "npm") {
  await support.seedBootstrapping(environmentId, install);
  const patch = support.readyPatch(environmentId, { ...support.BOOTSTRAP_RECEIPT, bundleHash });
  return transition(environmentId, "bootstrapping", "ready", patch);
}

function transition(
  environmentId: string,
  from: Transition["from"],
  to: Transition["to"],
  patch?: Transition["patch"],
) {
  return testState.store.transition({ environmentId, from, to, patch });
}

function tunnels(overrides: Partial<WorkerTunnelManager> = {}) {
  return {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    status: () => "connected" as const,
    ...overrides,
  } as unknown as WorkerTunnelManager;
}

async function seedAttached(environmentId: string, sessionId = "session-1") {
  await support.seedReady(environmentId);
  const patch = support.attachedPatch(environmentId, sessionId);
  return transition(environmentId, "ready", "attached", patch);
}

async function beginTeardown(record: Environment, lastError?: string) {
  const { environmentId, state } = record;
  await testState.store.requestDestroy({
    environmentId,
    state,
    ...(lastError ? { terminalState: "failed", lastError } : {}),
  });
  const patch = lastError ? { lastError } : undefined;
  await transition(environmentId, state, "draining", patch);
  await transition(environmentId, "draining", "destroying", patch);
}

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("defers teardown admitted during suspension and retries its intent after resume", async () => {
    const environment = await support.seedReady("suspended-teardown");
    const destroy = vi.fn(async () => {});
    const workerService = service({ destroy });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      await expect(workerService.destroy(environment.environmentId)).rejects.toThrow("paused");
      expect(destroy).not.toHaveBeenCalled();
      expectState(environment.environmentId, "destroying", {
        leaseId: environment.leaseId,
        destroyRequestedAtMs: expect.any(Number),
      });
    } finally {
      suspension?.rollback();
    }
    await workerService.reconcileOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expectState(environment.environmentId, "destroyed");
  });

  it.each(["shutdown", "timeout", "bootstrap failure"] as const)(
    "interrupts provider teardown on %s and retries the retained lease after restart",
    async (reason) => {
      const bootstrapFailure = reason === "bootstrap failure";
      const environment = bootstrapFailure
        ? await support.seedBootstrapping("interrupted-teardown")
        : await support.seedReady("interrupted-teardown");
      if (bootstrapFailure) {
        testState.prepareInstallation = vi.fn(fail("installation failed"));
      } else {
        await beginTeardown(environment);
      }
      const entered = createDeferred<AbortSignal | undefined>();
      const release = createDeferred();
      const destroy = vi.fn(async ({ signal }: WorkerLifecycleLease) => {
        entered.resolve(signal);
        await racePromiseWithAbortSignal(release.promise, signal);
      });
      const workerService = service({ destroy }, { providerCallTimeoutMs: 1_000 });
      if (reason === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const reconciliation = workerService.reconcileOnce();
      let stopping: Promise<void> | undefined;
      try {
        const signal = await entered.promise;
        if (reason !== "timeout") {
          stopping = workerService.stop();
        } else {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(signal?.aborted).toBe(true);
        await reconciliation;
        await (stopping ?? workerService.stop());
        expectState(environment.environmentId, "destroying", {
          leaseId: environment.leaseId,
          destroyRequestedAtMs: expect.any(Number),
          lastError: bootstrapFailure
            ? expect.stringContaining("installation failed")
            : expect.stringMatching(/paused|aborted|timed out/i),
        });
      } finally {
        vi.useRealTimers();
        release.resolve();
        await reconciliation;
        await (stopping ?? workerService.stop());
      }
      await support.reopenWorkerEnvironmentStore();
      const restarted = service({ destroy });
      await restarted.reconcileOnce();
      expect(destroy).toHaveBeenCalledTimes(2);
      expectState(environment.environmentId, bootstrapFailure ? "failed" : "destroyed");
    },
  );

  it("adopts a matching milestone-1 row that predates worker credentials", async () => {
    const environmentId = "worker-milestone-one";
    await support.seedReady(environmentId);
    testState.stateDb.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(environmentId);
    testState.stateDb.db
      .prepare("UPDATE worker_environments SET owner_epoch = 0 WHERE environment_id = ?")
      .run(environmentId);
    await support.reopenWorkerEnvironmentStore();
    const workerService = service({ inspect: fail("provider unavailable") });

    await workerService.reconcileOnce();

    expectState(environmentId, "ready", { ownerEpoch: 1, lastError: "provider unavailable" });
    expect(testState.store.getCredential(environmentId)).toMatchObject({
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(
      workerService.takeMintedCredential({ environmentId, ownerEpoch: 1, sessionId: null }),
    ).toMatchObject({
      credential: support.CREDENTIAL,
      ownerEpoch: 1,
    });
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("inspects a persisted lease with its profile snapshot after profile removal", async () => {
    await support.seedBootstrapping("worker-crash");
    testState.config.cloudWorkers!.profiles = {};
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const workerService = service({
      inspect,
      provision: fail("provision must not run for a known lease"),
    });

    await workerService.reconcileOnce();

    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leaseId: "lease:worker-crash", profile: { region: "test" } }),
    );
    expectState("worker-crash", "ready", {
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(testState.prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(testState.bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it.each(["worker-turn-only capability", "capability and profile removal"] as const)(
    "destroys a persisted SSH lease after %s",
    async (change) => {
      const removed = change === "capability and profile removal";
      const environmentId = "worker-stale-ssh-transport";
      const leaseId = removed ? "lease-unadvertised-persisted-ssh" : `lease:${environmentId}`;
      if (!removed) {
        await support.seedBootstrapping(environmentId);
      }
      const inspect = vi.fn(async () => ({ status: "active" as const }));
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({
        supportedExecutionModes: [removed ? "remote-exec" : "worker-turn"],
        ...(removed ? { provision: async () => ({ leaseId, ssh: support.SSH_ENDPOINT }) } : {}),
        inspect,
        destroy,
      });
      const workerService = support.createService(provider);
      let id = environmentId;
      if (removed) {
        id = (
          await create(workerService, "request-unadvertised-persisted-ssh", {
            executionMode: "remote-exec",
          })
        ).environmentId;
        provider.supportedExecutionModes = undefined;
        testState.config.cloudWorkers!.profiles = {};
      }
      await workerService.reconcileOnce();
      expect(inspect).not.toHaveBeenCalled();
      if (!removed) {
        expect(testState.bootstrapWorker).not.toHaveBeenCalled();
      }
      expect(destroy).toHaveBeenCalledWith(lifecycleLease(leaseId));
      expectState(id, "failed", {
        leaseId: null,
        sshEndpoint: null,
        lastError: removed
          ? expect.stringContaining("remote-exec")
          : "worker-turn providers must return a node lease",
      });
    },
  );

  it("P1: preserves a direct-only node lease after profile removal and reconciliation", async () => {
    const lease = {
      leaseId: "lease-direct-only-node",
      node: { deviceId: "device-direct-only-node" },
    };
    const inspect = vi.fn(async () => ({ status: "active" as const, sharedHost: false }));
    const destroy = vi.fn(async () => {});
    const workerService = service(
      {
        supportedExecutionModes: undefined,
        provision: async () => lease,
        inspect,
        destroy,
      },
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );
    const environment = await create(workerService, `request-${lease.leaseId}`);
    testState.config.cloudWorkers!.profiles = {};

    await workerService.reconcileOnce();

    expect(environment.profileSnapshot).not.toHaveProperty("executionMode");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: lease.leaseId, profile: { region: "test" } }),
    );
    expect(destroy).not.toHaveBeenCalled();
    expectState(environment.environmentId, "ready", {
      leaseId: lease.leaseId,
    });
  });

  it("re-enters bootstrapping when the durable receipt has a stale bundle hash", async () => {
    await seedStale("worker-stale", "b".repeat(64));

    await service().reconcileOnce();

    expectState("worker-stale", "ready", {
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(testState.bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("keeps an admitted lease retryable when local bundle identity is unavailable", async () => {
    const environmentId = "worker-current-bundle-unavailable";
    await support.seedReady(environmentId, "npm");
    const attachedId = "worker-attached-bundle-unavailable";
    await seedAttached(attachedId);
    testState.stateDb.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(attachedId);
    await support.reopenWorkerEnvironmentStore();
    testState.prepareInstallation = vi.fn(fail("local bundle identity is unavailable"));
    const destroy = vi.fn(async () => {});
    const workerService = service({ destroy });

    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expectState(environmentId, "ready", {
      leaseId: `lease:${environmentId}`,
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
      lastError: "local bundle identity is unavailable",
    });
    expect(testState.store.getCredential(attachedId)).toBeUndefined();
    expect(
      workerService.takeMintedCredential({
        environmentId: attachedId,
        ownerEpoch: 2,
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it("tears down a persisted ready lease when mismatched npm preparation fails", async () => {
    const environmentId = "worker-prepare-ready";
    await seedStale(environmentId, "c".repeat(64), "npm");
    testState.prepareInstallation = vi.fn(async (install) => {
      if (install === "bundle") {
        return support.BUNDLE_ARTIFACT;
      }
      throw new Error("released npm artifact is unavailable");
    });
    const order: string[] = [];
    const tunnelManager = tunnels({
      stop: vi.fn(async () => void order.push("tunnel-stop")),
    });
    const destroy = vi.fn(async () => void order.push("provider-destroy"));

    await service({ destroy }, { tunnelManager }).reconcileOnce();

    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
    expect(destroy).toHaveBeenCalledWith(lifecycleLease(`lease:${environmentId}`));
    expectState(environmentId, "failed", {
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "released npm artifact is unavailable",
    });
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("uses the snapshotted npm selection after live config changes", async () => {
    support.getDevelopmentProfile().install = "npm";
    const workerService = service({
      provision: async () => {
        support.getDevelopmentProfile().install = "bundle";
        return { leaseId: "lease-npm", ssh: support.SSH_ENDPOINT };
      },
    });

    const result = await create(workerService, "request-npm");

    expect(result).toMatchObject({
      state: "ready",
      profileSnapshot: { install: "npm" },
    });
    expect(testState.prepareInstallation).toHaveBeenCalledWith("npm");
    expect(testState.bootstrapWorker).toHaveBeenCalledWith(
      expect.objectContaining({ installation: support.NPM_ARTIFACT }),
    );
  });

  it("fences unknown leases before stop and retries their durable teardown", async () => {
    const originalOwner = await support.seedReady("worker-unknown");
    await support.seedReady("worker-transient");
    await beginTeardown(await support.seedReady("worker-destroyed-unknown"));
    const provider = support.createProvider({
      inspect: async ({ leaseId }) => {
        if (leaseId !== "lease:worker-transient") {
          return { status: "unknown" };
        }
        throw new Error("provider temporarily unavailable");
      },
    });
    const failedTunnelStops = new Set<string>();
    const tunnelManager = tunnels({
      stop: vi.fn(async (environmentId: string) => {
        if (!failedTunnelStops.has(environmentId)) {
          failedTunnelStops.add(environmentId);
          throw new Error("tunnel stop interrupted");
        }
      }),
    });
    const workerService = support.createService(provider, { tunnelManager });
    const admitted = await workerService.admitWorker(support.admissionFor("worker-unknown"));
    if (!admitted.ok) {
      throw new Error("fixture worker admission failed");
    }

    await workerService.reconcileOnce();

    expectState("worker-unknown", "ready", {
      ownerEpoch: originalOwner.ownerEpoch,
      leaseId: originalOwner.leaseId,
      attachedSessionIds: originalOwner.attachedSessionIds,
      destroyRequestedAtMs: testState.nowMs,
      teardownTerminalState: "failed",
      lastError: "Worker provider no longer recognizes the lease",
    });
    expect(testState.store.get("worker-destroyed-unknown")?.state).toBe("destroying");
    expect(workerService.validateWorkerConnection(admitted.identity)).toBe("credential-replaced");
    expectState("worker-transient", "ready", {
      lastError: "provider temporarily unavailable",
    });
    await workerService.reconcileOnce();
    expect(tunnelManager.stop).toHaveBeenCalledTimes(4);
    expectState("worker-unknown", "failed", {
      leaseId: null,
      lastError: "Worker provider no longer recognizes the lease",
    });
    expectState("worker-destroyed-unknown", "destroyed");
  });

  it("keeps a dormant paired-device lease in its nonterminal holding state", async () => {
    await support.seedReady("worker-dormant");
    const destroy = vi.fn(async () => {});
    const tunnelManager = tunnels({
      status: () => "stopped" as const,
    });
    const workerService = service(
      { inspect: async () => ({ status: "dormant" }), destroy },
      { tunnelManager },
    );

    await workerService.reconcileOnce();
    await workerService.reconcileOnce();

    expectState("worker-dormant", "ready");
    expect(tunnelManager.stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { status: "future" },
    { status: "active", sharedHost: "yes" },
    { status: "unknown", sharedHost: true },
  ])("retains retryable state for malformed inspection result %#", async (inspection) => {
    await support.seedReady("worker-malformed");
    await service({ inspect: async () => inspection as never }).reconcileOnce();

    expectState("worker-malformed", "ready", {
      lastError: expect.stringContaining("invalid inspection"),
    });
  });

  it("records provider-proven teardown without local intent as a failure", async () => {
    await support.seedReady("worker-destroyed-ready");
    await seedAttached("worker-destroyed-attached");
    await support.seedReady("worker-destroyed-draining");
    await transition("worker-destroyed-draining", "ready", "draining");
    const workerService = service({
      inspect: async () => ({ status: "destroyed" }),
      destroy: fail("destroy must not run for provider-proven teardown"),
    });

    await workerService.reconcileOnce();

    for (const environmentId of [
      "worker-destroyed-ready",
      "worker-destroyed-attached",
      "worker-destroyed-draining",
    ]) {
      expectState(environmentId, "failed", {
        attachedSessionIds: [],
        lastError: "Worker environment disappeared before teardown was requested",
      });
    }
  });

  it("adopts a provider-proven bootstrap teardown as failed after restart", async () => {
    const bootstrapping = await support.seedBootstrapping("worker-bootstrap-teardown-crash");
    await beginTeardown(bootstrapping, "remote bootstrap failed");
    const destroy = vi.fn(async () => {});
    const workerService = service({
      inspect: async () => ({ status: "destroyed" }),
      destroy,
    });
    testState.providersEnabled = false;

    await workerService.reconcileOnce();
    expectState(bootstrapping.environmentId, "destroying", {
      lastError: "remote bootstrap failed",
    });

    testState.providersEnabled = true;
    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expectState(bootstrapping.environmentId, "failed", {
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });
  });

  it("reconcile preserves the exact attached owner until remote stop is confirmed across restart", async () => {
    const environmentId = "worker-retained-teardown";
    const attached = await seedAttached(environmentId, "session-retained");
    let disconnected = true;
    const stop = vi.fn(async (id: string, epoch?: number) => {
      expectState(id, "attached", {
        attachedSessionIds: ["session-retained"],
        ownerEpoch: attached.ownerEpoch,
        destroyRequestedAtMs: expect.any(Number),
      });
      expect(epoch).toBe(attached.ownerEpoch);
      if (disconnected) {
        throw new Error("node disconnected before stop confirmation");
      }
    });
    const tunnelManager = {
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({ destroy });
    const first = support.createService(provider, { tunnelManager });
    await testState.store.requestDestroy({ environmentId, state: "attached" });
    await first.reconcileOnce();
    expectState(environmentId, "attached", {
      ownerEpoch: attached.ownerEpoch,
      attachedSessionIds: ["session-retained"],
    });
    expect(testState.store.getCredential(environmentId)).toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();

    await first.stop();
    disconnected = false;
    const restarted = support.createService(provider, { tunnelManager });
    await restarted.reconcileOnce();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    expectState(environmentId, "destroyed");
  });

  it("does not let an awaited old-owner stop retire a replacement attachment", async () => {
    const environmentId = "worker-replaced-during-stop";
    const attached = await seedAttached(environmentId, "session-old");
    const stopReturned = createDeferred();
    const stop = vi.fn(async () => await stopReturned.promise);
    const tunnelManager = {
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = service(
      { inspect: async () => ({ status: "active", sharedHost: true }) },
      { tunnelManager },
    );
    const reconciling = workerService.reconcileOnce();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(environmentId, attached.ownerEpoch));
    await transition(environmentId, "attached", "idle");
    const replacement = await transition(
      environmentId,
      "idle",
      "attached",
      support.attachedPatch(environmentId, "session-new"),
    );
    stopReturned.resolve();
    await reconciling;

    expectState(environmentId, "attached", {
      ownerEpoch: replacement.ownerEpoch,
      attachedSessionIds: ["session-new"],
    });
    expect(testState.store.getCredential(environmentId)?.sessionId).toBe("session-new");
  });

  it("retains teardown intent across an indeterminate allocation resolution", async () => {
    testState.prepareInstallation = vi.fn(
      fail("bundle preparation must not block teardown adoption"),
    );
    const intent = await testState.store.createIntent({
      environmentId: "worker-pending-destroy-retry",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy-retry",
    });
    await transition(intent.environmentId, "requested", "provisioning");
    let resolutionFails = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      resolveAllocation: async () => {
        if (resolutionFails) {
          throw new Error("allocation identity unavailable");
        }
        return { leaseId: "lease-retried", sharedHost: false };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });
    const workerService = support.createService(provider);

    testState.providersEnabled = false;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(testState.store.get(intent.environmentId)?.destroyRequestedAtMs).not.toBeNull();

    testState.providersEnabled = true;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expectState(intent.environmentId, "provisioning", {
      destroyRequestedAtMs: expect.any(Number),
    });

    resolutionFails = false;
    await workerService.reconcileOnce();
    expect(testState.store.get(intent.environmentId)?.state).toBe("destroyed");
    expect(destroyed).toEqual([lifecycleLease("lease-retried")]);
    expect(testState.prepareInstallation).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as support from "./service.test-support.js";
import { testState } from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;
type Transition = Parameters<typeof testState.store.transition>[0];

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
  return transition(
    environmentId,
    "ready",
    "attached",
    support.attachedPatch(environmentId, sessionId),
  );
}

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

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
    const workerService = support.createService(
      support.createProvider({
        inspect: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );

    await workerService.reconcileOnce();

    expect(testState.store.get(environmentId)?.ownerEpoch).toBe(1);
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
    expect(testState.store.get(environmentId)?.lastError).toBe("provider unavailable");
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("inspects a persisted lease with its profile snapshot after profile removal", async () => {
    await support.seedBootstrapping("worker-crash");
    testState.config.cloudWorkers!.profiles = {};
    const inspected: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        return { status: "active" };
      },
      provision: async () => {
        throw new Error("provision must not run for a known lease");
      },
    });

    await support.createService(provider).reconcileOnce();

    expect(inspected).toEqual([
      expect.objectContaining({ leaseId: "lease:worker-crash", profile: { region: "test" } }),
    ]);
    expect(testState.store.get("worker-crash")).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(testState.prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(testState.bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("destroys a persisted SSH lease after its provider becomes worker-turn-only", async () => {
    const environmentId = "worker-stale-ssh-transport";
    await support.seedBootstrapping(environmentId);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        inspect,
        destroy,
      }),
    );

    await workerService.reconcileOnce();

    expect(inspect).not.toHaveBeenCalled();
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith({
      leaseId: `lease:${environmentId}`,
      profile: { region: "test" },
    });
    expect(testState.store.get(environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      lastError: "worker-turn providers must return a node lease",
    });
  });

  it("P1: preserves a direct-only node lease after profile removal and reconciliation", async () => {
    const lease = {
      leaseId: "lease-direct-only-node",
      node: { deviceId: "device-direct-only-node" },
    };
    const inspect = vi.fn(async () => ({ status: "active" as const, sharedHost: false }));
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: undefined,
        provision: async () => lease,
        inspect,
        destroy,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );
    const environment = await workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: `request-${lease.leaseId}`,
    });
    testState.config.cloudWorkers!.profiles = {};

    await workerService.reconcileOnce();

    expect(environment.profileSnapshot).not.toHaveProperty("executionMode");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: lease.leaseId, profile: { region: "test" } }),
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(testState.store.get(environment.environmentId)).toMatchObject({
      state: "ready",
      leaseId: lease.leaseId,
    });
  });

  it("P1: destroys a persisted SSH lease when provider capabilities and its profile are removed", async () => {
    const leaseId = "lease-unadvertised-persisted-ssh";
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      supportedExecutionModes: ["remote-exec"],
      provision: async () => ({ leaseId, ssh: support.SSH_ENDPOINT }),
      inspect,
      destroy,
    });
    const workerService = support.createService(provider);
    const environment = await workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-unadvertised-persisted-ssh",
      executionMode: "remote-exec",
    });
    provider.supportedExecutionModes = undefined;
    testState.config.cloudWorkers!.profiles = {};

    await workerService.reconcileOnce();

    expect(inspect).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
    expect(testState.store.get(environment.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      lastError: expect.stringContaining("remote-exec"),
    });
  });

  it("re-enters bootstrapping when the durable receipt has a stale bundle hash", async () => {
    const bootstrapping = await support.seedBootstrapping("worker-stale");
    await testState.store.transition({
      environmentId: bootstrapping.environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(bootstrapping.environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "b".repeat(64),
      }),
    });

    await support.createService(support.createProvider()).reconcileOnce();

    expect(testState.store.get("worker-stale")).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(testState.bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("keeps an admitted lease retryable when local bundle identity is unavailable", async () => {
    const environmentId = "worker-current-bundle-unavailable";
    await support.seedReady(environmentId, "npm");
    const attachedId = "worker-attached-bundle-unavailable";
    await support.seedReady(attachedId);
    await transition(
      attachedId,
      "ready",
      "attached",
      support.attachedPatch(attachedId, "session-1"),
    );
    testState.stateDb.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(attachedId);
    await support.reopenWorkerEnvironmentStore();
    testState.prepareInstallation = vi.fn(async () => {
      throw new Error("local bundle identity is unavailable");
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));

    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expect(testState.store.get(environmentId)).toMatchObject({
      state: "ready",
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
    const bootstrapping = await support.seedBootstrapping(environmentId, "npm");
    await testState.store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "c".repeat(64),
      }),
    });
    testState.prepareInstallation = vi.fn(async (install) => {
      if (install === "bundle") {
        return support.BUNDLE_ARTIFACT;
      }
      throw new Error("released npm artifact is unavailable");
    });
    const order: string[] = [];
    const tunnelManager = tunnels({
      stop: vi.fn(async () => {
        order.push("tunnel-stop");
      }),
    });
    const destroy = vi.fn(async () => {
      order.push("provider-destroy");
    });

    await support
      .createService(support.createProvider({ destroy }), { tunnelManager })
      .reconcileOnce();

    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
    expect(destroy).toHaveBeenCalledWith({
      leaseId: `lease:${environmentId}`,
      profile: { region: "test" },
    });
    expect(testState.store.get(environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "released npm artifact is unavailable",
    });
    expect(testState.prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(testState.prepareInstallation).toHaveBeenCalledWith("npm");
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("uses the snapshotted npm selection after live config changes", async () => {
    support.getDevelopmentProfile().install = "npm";
    const provider = support.createProvider({
      provision: async () => {
        support.getDevelopmentProfile().install = "bundle";
        return { leaseId: "lease-npm", ssh: support.SSH_ENDPOINT };
      },
    });

    const result = await support
      .createService(provider)
      .createWithRequest({ profileId: "development", idempotencyKey: "request-npm" });

    expect(result).toMatchObject({
      state: "ready",
      profileSnapshot: { install: "npm" },
    });
    expect(testState.prepareInstallation).toHaveBeenCalledWith("npm");
    expect(testState.bootstrapWorker).toHaveBeenCalledWith({
      operationId: result.provisionOperationId,
      sshEndpoint: support.SSH_ENDPOINT,
      installation: support.NPM_ARTIFACT,
      resolveIdentity: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  it("fences unknown leases before stop and retries their durable teardown", async () => {
    const originalOwner = await support.seedReady("worker-unknown");
    await support.seedReady("worker-transient");
    await support.seedReady("worker-destroyed-unknown");
    await testState.store.requestDestroy({
      environmentId: "worker-destroyed-unknown",
      state: "ready",
    });
    await transition("worker-destroyed-unknown", "ready", "draining");
    await transition("worker-destroyed-unknown", "draining", "destroying");
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

    expect(testState.store.get("worker-unknown")).toMatchObject({
      state: "ready",
      ownerEpoch: originalOwner.ownerEpoch,
      leaseId: originalOwner.leaseId,
      attachedSessionIds: originalOwner.attachedSessionIds,
      destroyRequestedAtMs: testState.nowMs,
      teardownTerminalState: "failed",
      lastError: "Worker provider no longer recognizes the lease",
    });
    expect(testState.store.get("worker-destroyed-unknown")?.state).toBe("destroying");
    expect(workerService.validateWorkerConnection(admitted.identity)).toBe("credential-replaced");
    expect(testState.store.get("worker-transient")).toMatchObject({
      state: "ready",
      lastError: "provider temporarily unavailable",
    });
    await workerService.reconcileOnce();
    expect(tunnelManager.stop).toHaveBeenCalledTimes(4);
    expect(testState.store.get("worker-unknown")).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "Worker provider no longer recognizes the lease",
    });
    expect(testState.store.get("worker-destroyed-unknown")).toMatchObject({
      state: "destroyed",
    });
  });

  it("keeps a dormant paired-device lease in its nonterminal holding state", async () => {
    await support.seedReady("worker-dormant");
    const destroy = vi.fn(async () => {});
    const tunnelManager = tunnels({
      status: () => "stopped" as const,
    });
    const workerService = support.createService(
      support.createProvider({ inspect: async () => ({ status: "dormant" }), destroy }),
      { tunnelManager },
    );

    await workerService.reconcileOnce();
    await workerService.reconcileOnce();

    expect(testState.store.get("worker-dormant")).toMatchObject({ state: "ready" });
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
    const provider = support.createProvider({ inspect: async () => inspection as never });

    await support.createService(provider).reconcileOnce();

    expect(testState.store.get("worker-malformed")).toMatchObject({
      state: "ready",
      lastError: expect.stringContaining("invalid inspection"),
    });
  });

  it("records provider-proven teardown without local intent as a failure", async () => {
    await support.seedReady("worker-destroyed-ready");
    await seedAttached("worker-destroyed-attached");
    await support.seedReady("worker-destroyed-draining");
    await transition("worker-destroyed-draining", "ready", "draining");
    const provider = support.createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy: async () => {
        throw new Error("destroy must not run for provider-proven teardown");
      },
    });

    const workerService = support.createService(provider);
    await workerService.reconcileOnce();

    for (const environmentId of [
      "worker-destroyed-ready",
      "worker-destroyed-attached",
      "worker-destroyed-draining",
    ]) {
      expect(testState.store.get(environmentId)).toMatchObject({
        state: "failed",
        attachedSessionIds: [],
        lastError: "Worker environment disappeared before teardown was requested",
      });
    }
  });

  it("adopts a provider-proven bootstrap teardown as failed after restart", async () => {
    const bootstrapping = await support.seedBootstrapping("worker-bootstrap-teardown-crash");
    const requested = await testState.store.requestDestroy({
      environmentId: bootstrapping.environmentId,
      state: bootstrapping.state,
      terminalState: "failed",
      lastError: "remote bootstrap failed",
    });
    const draining = await transition(requested.environmentId, requested.state, "draining", {
      lastError: requested.lastError,
    });
    await transition(draining.environmentId, draining.state, "destroying", {
      lastError: draining.lastError,
    });
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy,
    });
    testState.providersEnabled = false;
    const workerService = support.createService(provider);

    await workerService.reconcileOnce();
    expect(testState.store.get(bootstrapping.environmentId)).toMatchObject({
      state: "destroying",
      lastError: "remote bootstrap failed",
    });

    testState.providersEnabled = true;
    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expect(testState.store.get(bootstrapping.environmentId)).toMatchObject({
      state: "failed",
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
      expect(testState.store.get(id)).toMatchObject({
        state: "attached",
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
    expect(testState.store.get(environmentId)).toMatchObject({
      state: "attached",
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
    expect(testState.store.get(environmentId)).toMatchObject({ state: "destroyed" });
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
    const service = support.createService(
      support.createProvider({ inspect: async () => ({ status: "active", sharedHost: true }) }),
      { tunnelManager },
    );
    const reconciling = service.reconcileOnce();
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

    expect(testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      ownerEpoch: replacement.ownerEpoch,
      attachedSessionIds: ["session-new"],
    });
    expect(testState.store.getCredential(environmentId)?.sessionId).toBe("session-new");
  });

  it("retains teardown intent across an indeterminate allocation resolution", async () => {
    testState.prepareInstallation = vi.fn(async () => {
      throw new Error("bundle preparation must not block teardown adoption");
    });
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
    expect(testState.store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      destroyRequestedAtMs: expect.any(Number),
    });

    resolutionFails = false;
    await workerService.reconcileOnce();
    expect(testState.store.get(intent.environmentId)?.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-retried", profile: { region: "test" } }]);
    expect(testState.prepareInstallation).not.toHaveBeenCalled();
  });
});

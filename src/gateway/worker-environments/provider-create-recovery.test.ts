import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import * as profileReader from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { prepareUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import type { QueuedOperatorRecoverySource } from "../operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "../operator-run-recovery.js";
import {
  pairedOperator,
  persistDevices,
  recoveryFixture,
} from "../operator-run-recovery.test-support.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";

describe("worker creation source recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let releaseCatalog = () => {};

  const prepareCatalog = async () => {
    releaseCatalog = (await prepareUserProfileCatalogForTest()).release;
  };
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    await prepareCatalog();
    support.testState.releaseTurnOwners.push(() => releaseCatalog());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const reopen = async () => {
    releaseCatalog();
    await support.reopenWorkerEnvironmentStore();
    await prepareCatalog();
  };
  const originalCaller = async (device = pairedOperator(), sharedGeneration?: string) => {
    const profile = ensureProfileForEmail("worker-creator@example.test");
    const context = createContext();
    if (sharedGeneration !== undefined) {
      context.sharedGatewaySessionGenerationState = new SharedGatewaySessionGenerationState({
        current: sharedGeneration,
        required: null,
      });
    }
    const fixture = await recoveryFixture(support.testState.root, profile.id, {
      context,
      sharedGeneration,
      config: support.testState.config,
      device,
    });
    const source: QueuedOperatorRecoverySource = { kind: "gateway", snapshot: fixture.snapshot };
    return { ...fixture, source };
  };
  const seedIntent = (key: string, provisionSource: QueuedOperatorRecoverySource) =>
    support.testState.store.createIntent({
      ...deriveEnvironmentIntent(key),
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionSource,
    });

  it("restores the admitted source after reopening a requested intent", async () => {
    const caller = await originalCaller();
    const intent = await seedIntent("valid-recovery", caller.source);
    await reopen();
    const provision = vi.fn(async () => ({ leaseId: "lease-valid", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }), {
      resolveGatewayContext: () => caller.context,
    });

    await service.reconcileOnce();

    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "ready",
      leaseId: "lease-valid",
      provisionOperationId: intent.provisionOperationId,
      provisionSource: caller.source,
    });
    expect(provision).toHaveBeenCalledExactlyOnceWith(
      { region: "test" },
      intent.provisionOperationId,
      expect.any(Object),
    );
  });

  it("retires a requested intent whose original source cannot be recovered", async () => {
    const intent = await seedIntent("source-unavailable", { kind: "unavailable" });
    await reopen();
    const provision = vi.fn();
    const service = support.createService(support.createProvider({ provision }));

    await service.reconcileOnce();

    expect(provision).not.toHaveBeenCalled();
    expect(service.get(intent.environmentId)).toMatchObject({ state: "failed", leaseId: null });
  });

  it("does not rebind a revoked original device to a later valid caller", async () => {
    const original = await originalCaller();
    const intent = await seedIntent("same-key", original.source);
    const later = await originalCaller({
      ...pairedOperator(),
      deviceId: "later-device",
      publicKey: "later-public-key",
    });
    await reopen();
    const laterAuthority = await restoreGatewayQueuedOperatorRecovery({
      source: later.source,
      context: later.context,
      assertCurrent: () => {},
    });
    const provision = vi.fn();
    const service = support.createService(support.createProvider({ provision }), {
      resolveGatewayContext: () => original.context,
    });
    try {
      expect(laterAuthority.authority.assertCurrent).not.toThrow();
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "same-key",
          provisionSource: later.source,
          beforeProvision: laterAuthority.authority.assertCurrent,
        }),
      ).rejects.toThrow("Worker creation authority changed");
    } finally {
      laterAuthority.release();
    }

    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      provisionSource: original.source,
    });
    await service.reconcileOnce();
    expect(provision).not.toHaveBeenCalled();
  });

  it("leaves a requested intent retryable while its recovery context is unavailable", async () => {
    const caller = await originalCaller();
    const intent = await seedIntent("missing-context", caller.source);
    await reopen();
    const provision = vi.fn(async () => ({ leaseId: "lease-context", ssh: support.SSH_ENDPOINT }));
    const resolveAllocation = vi.fn();
    const destroy = vi.fn();
    let contextAvailable = false;
    const service = support.createService(
      support.createProvider({ provision, resolveAllocation, destroy }),
      { resolveGatewayContext: () => (contextAvailable ? caller.context : undefined) },
    );

    await service.reconcileOnce();
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "requested",
      leaseId: null,
      destroyRequestedAtMs: null,
      lastError: expect.stringContaining("recovery is pending"),
    });
    expect(provision).not.toHaveBeenCalled();
    expect(resolveAllocation).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();

    contextAvailable = true;
    await service.reconcileOnce();
    expect(service.get(intent.environmentId)?.state).toBe("ready");
    expect(provision).toHaveBeenCalledOnce();
  });

  it("does not allocate or destroy an uncertain provision when its identity read fails", async () => {
    const caller = await originalCaller();
    const intent = await seedIntent("identity-read-refused", caller.source);
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    await reopen();
    const provision = vi.fn(async () => ({ leaseId: "lease-read", ssh: support.SSH_ENDPOINT }));
    const resolveAllocation = vi.fn();
    const destroy = vi.fn();
    const service = support.createService(
      support.createProvider({ provision, resolveAllocation, destroy }),
      { resolveGatewayContext: () => caller.context },
    );
    const identityRead = vi
      .spyOn(profileReader, "prepareUserProfileIdentity")
      .mockRejectedValueOnce(new Error("synthetic identity reader unavailable"));

    await service.reconcileOnce();
    expect(identityRead).toHaveBeenCalledOnce();
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      destroyRequestedAtMs: null,
      lastError: expect.stringContaining("recovery is pending"),
    });
    expect(provision).not.toHaveBeenCalled();
    expect(resolveAllocation).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();

    identityRead.mockRestore();
    await service.reconcileOnce();
    expect(service.get(intent.environmentId)?.state).toBe("ready");
    expect(provision).toHaveBeenCalledOnce();
  });

  it.each([
    ["requested", true],
    ["provisioning", true],
    ["provisioning", false],
  ] as const)(
    "settles %s after shared credential rotation (owner available: %s)",
    async (state, ownerAvailable) => {
      const caller = await originalCaller(pairedOperator(), "original-generation");
      const intent = await seedIntent(`shared-rotation-${state}-${ownerAvailable}`, caller.source);
      if (state === "provisioning") {
        await support.testState.store.transition({
          environmentId: intent.environmentId,
          from: "requested",
          to: "provisioning",
        });
      }
      await reopen();
      const owner = expectDefined(
        caller.context.sharedGatewaySessionGenerationState,
        "shared authentication owner",
      );
      owner.publish({ current: "replacement-generation", required: null });
      const provision = vi.fn();
      const resolveAllocation = vi.fn(async () => ({
        leaseId: "lease-rotation",
        sharedHost: false,
      }));
      const destroy = vi.fn<WorkerProvider["destroy"]>(async () => {});
      let available = ownerAvailable;
      const service = support.createService(
        support.createProvider({ provision, resolveAllocation, destroy }),
        {
          resolveGatewayContext: () =>
            available
              ? caller.context
              : { ...caller.context, sharedGatewaySessionGenerationState: undefined },
        },
      );

      await service.reconcileOnce();
      if (!ownerAvailable) {
        expect(support.testState.store.get(intent.environmentId)).toMatchObject({
          state,
          destroyRequestedAtMs: null,
          lastError: expect.stringContaining("recovery is pending"),
        });
        expect(resolveAllocation).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        available = true;
        await service.reconcileOnce();
      }

      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        provisionSource: caller.source,
      });
      expect(provision).not.toHaveBeenCalled();
      expect(resolveAllocation).toHaveBeenCalledTimes(state === "provisioning" ? 1 : 0);
      expect(destroy).toHaveBeenCalledTimes(state === "provisioning" ? 1 : 0);
      if (state === "provisioning") {
        expect(resolveAllocation).toHaveBeenCalledWith(
          { region: "test" },
          intent.provisionOperationId,
        );
        expect(destroy.mock.calls[0]?.[0]).toMatchObject({ leaseId: "lease-rotation" });
      }
    },
  );

  it("cleans an allocation with a lost reply after original device revocation without replay", async () => {
    const caller = await originalCaller();
    const held = await restoreGatewayQueuedOperatorRecovery({
      source: caller.source,
      context: caller.context,
      assertCurrent: () => {},
    });
    const provision = vi.fn(async () => {
      throw new Error("synthetic provision reply lost after allocation");
    });
    const resolveAllocation = vi.fn(async () => ({ leaseId: "lease-lost", sharedHost: false }));
    const destroy = vi.fn<WorkerProvider["destroy"]>(async () => {});
    const provider = support.createProvider({ provision, resolveAllocation, destroy });
    const first = support.createService(provider, { resolveGatewayContext: () => caller.context });
    try {
      await expect(
        first.createWithRequest({
          profileId: "development",
          idempotencyKey: "lost-reply",
          provisionSource: caller.source,
          beforeProvision: held.authority.assertCurrent,
        }),
      ).rejects.toThrow("reply lost after allocation");
    } finally {
      held.release();
    }
    const intent = expectDefined(support.testState.store.list()[0], "uncertain provision");
    expect(intent).toMatchObject({ state: "provisioning", leaseId: null });
    persistDevices(support.testState.root, [], "both");
    await reopen();
    const restarted = support.createService(provider, {
      resolveGatewayContext: () => caller.context,
    });

    await restarted.reconcileOnce();

    expect(provision).toHaveBeenCalledOnce();
    expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
      { region: "test" },
      intent.provisionOperationId,
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.calls[0]?.[0]).toMatchObject({
      leaseId: "lease-lost",
      profile: { region: "test" },
    });
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      teardownTerminalState: "failed",
    });
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("retries initial bootstrap cleanup after revocation even without recovery context", async () => {
    const caller = await originalCaller();
    const intent = await seedIntent("initial-bootstrap", caller.source);
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const bootstrapping = await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-bootstrap", sshEndpoint: support.SSH_ENDPOINT },
    });
    expect(bootstrapping.ownerEpoch).toBe(0);
    persistDevices(support.testState.root, [], "both");
    await reopen();
    const provision = vi.fn();
    const resolveAllocation = vi.fn();
    const destroy = vi
      .fn<WorkerProvider["destroy"]>(async () => {})
      .mockRejectedValueOnce(new Error("synthetic destroy unavailable"));
    let contextAvailable = true;
    const service = support.createService(
      support.createProvider({ provision, resolveAllocation, destroy }),
      { resolveGatewayContext: () => (contextAvailable ? caller.context : undefined) },
    );

    await service.reconcileOnce();
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "destroying",
      leaseId: "lease-bootstrap",
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
    });
    contextAvailable = false;
    support.testState.nowMs += 60_000;
    await service.reconcileOnce();

    expect(destroy).toHaveBeenCalledTimes(2);
    for (const [lease] of destroy.mock.calls) {
      expect(lease).toMatchObject({ leaseId: "lease-bootstrap", profile: { region: "test" } });
    }
    expect(provision).not.toHaveBeenCalled();
    expect(resolveAllocation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(service.get(intent.environmentId)?.state).toBe("failed");
  });

  it("cleans a provider allocation when the live original source is revoked before its reply", async () => {
    const caller = await originalCaller();
    const held = await restoreGatewayQueuedOperatorRecovery({
      source: caller.source,
      context: caller.context,
      assertCurrent: () => {},
    });
    const provision = vi.fn(async () => {
      persistDevices(support.testState.root, [], "both");
      invalidateGatewayDeviceRevocation(caller.context, "recovery-device", "operator");
      return { leaseId: "lease-live-revoked", ssh: support.SSH_ENDPOINT };
    });
    const resolveAllocation = vi.fn(async () => ({
      leaseId: "lease-live-revoked",
      sharedHost: false,
    }));
    const destroy = vi.fn(async () => {});
    const service = support.createService(
      support.createProvider({ provision, resolveAllocation, destroy }),
      { resolveGatewayContext: () => caller.context },
    );
    try {
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "live-revoked",
          provisionSource: caller.source,
          beforeProvision: held.authority.assertCurrent,
        }),
      ).rejects.toThrow("Worker creation authority changed");
    } finally {
      held.release();
    }

    expect(provision).toHaveBeenCalledOnce();
    expect(resolveAllocation).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("recovers later maintenance independently of its original creator", async () => {
    const caller = await originalCaller();
    const intent = await seedIntent("maintenance-bootstrap", caller.source);
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-maintenance", sshEndpoint: support.SSH_ENDPOINT },
    });
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(intent.environmentId),
    });
    const maintaining = await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "ready",
      to: "bootstrapping",
    });
    expect(maintaining.ownerEpoch).toBeGreaterThan(0);
    expect(maintaining.bootstrapReceipt).toBeNull();
    persistDevices(support.testState.root, [], "both");
    await reopen();
    const provision = vi.fn();
    const destroy = vi.fn();
    const service = support.createService(support.createProvider({ provision, destroy }));

    await service.reconcileOnce();

    expect(service.get(intent.environmentId)?.state).toBe("ready");
    expect(support.testState.bootstrapWorker).toHaveBeenCalledOnce();
    expect(provision).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});

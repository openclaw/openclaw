import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { nodeArtifacts, pendingNodeEnrollment } from "./provider-lifecycle.test-support.js";
import * as repositoryIdentity from "./repository-github-identity.js";
import * as repositoryAdmission from "./repository-project-admission.js";
import * as support from "./service.test-support.js";

const imageOptions = { imageReserve: true as const };

describe("runtime-only image allocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  function fixture() {
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      supportedExecutionModes: ["worker-turn"],
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux" }),
      provision: vi.fn(async (_profile, _operationId, options) => {
        const enrollment = await options!.beginNodeEnrollment!();
        if (enrollment.mode !== "connect") {
          throw new Error("Expected image node enrollment");
        }
        await completeWorkerNodeSetupForTest({
          baseDir: support.testState.root,
          store: support.testState.store,
          setupId: enrollment.setupId,
          deviceId: "image-node",
          completedAtMs: support.testState.nowMs,
        });
        return { leaseId: "image-lease", node: { deviceId: "image-node" }, sharedHost: false };
      }),
    });
    const prepareNodeArtifacts = vi.fn(async () => nodeArtifacts());
    const prepareNodeBootstrap = vi.fn(async () => support.NODE_BOOTSTRAP.sha256);
    const serviceOptions = {
      prepareNodeBootstrap,
      projectNamespace: "gateway-test",
      prepareNodeArtifacts,
      prepareNodeEnrollment: (record: Parameters<typeof pendingNodeEnrollment>[0]) =>
        pendingNodeEnrollment(record, async () => "image-node"),
      ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
    };
    const service = support.createService(provider, serviceOptions);
    return { provider, prepareNodeArtifacts, prepareNodeBootstrap, serviceOptions, service };
  }

  it("allocates runtime capacity without repository admission, credentials, or setup", async () => {
    const source = vi.spyOn(repositoryAdmission, "prepareRepositoryWorkerProjectSource");
    const credential = vi.spyOn(repositoryIdentity, "prepareRepositoryGitHubIdentity");
    const { service, provider } = fixture();
    const intent = await service.prepareProjectIntent("development", imageOptions);
    expect(intent.profileSnapshot.runtimePreparation).toMatchObject({ source: "image" });
    expect(intent.profileSnapshot).not.toHaveProperty("project");
    const ready = await service.createWithRequest({
      profileId: "development",
      idempotencyKey: "image-only",
      admittedIntent: intent,
    });
    expect(ready.state).toBe("ready");
    expect(provider.provision).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.provision).mock.calls[0]?.[2]?.project).toBeUndefined();
    expect(source).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it("does not offer or consume image capacity as an empty workspace", async () => {
    const { service } = fixture();
    const image = await service.prepareProjectIntent("development", {
      ...imageOptions,
      executionMode: "worker-turn",
    });
    const empty = await service.prepareProjectIntent("development", {
      emptyWorkspace: true,
      executionMode: "worker-turn",
    });
    const key = image.profileSnapshot.runtimePreparation!.key;
    const store = support.testState.store;
    const environmentId = "image-spare";
    await store.createIntent({
      environmentId,
      providerId: image.providerId,
      profileId: "development",
      profileSnapshot: image.profileSnapshot,
      provisionOperationId: "image-spare-operation",
      preparation: { purpose: "reserve", key, demandAtMs: 1_000, expiresAtMs: 10_000 },
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    const ready = await store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId),
        leaseId: "image-lease",
        nodeDeviceId: "image-node",
        sharedHost: false,
      },
    });
    expect(service.getPreparedCandidates(empty)).toEqual([]);
    expect(
      service.getPreparedCandidates(image).map((candidate) => candidate.environmentId),
    ).toEqual([environmentId]);
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const identity = {
      sessionId: "claim",
      sessionKey: "agent:main:claim",
      agentId: "main",
      executionMode: "worker-turn" as const,
    };
    const requested = await placements.startDispatch(identity);
    const claim = {
      ...identity,
      expectedGeneration: requested.generation,
      environmentId,
      ownerEpoch: ready.ownerEpoch,
      providerId: image.providerId,
      profileId: "development",
      nodeDeviceId: "image-node",
      leaseId: "image-lease",
      bundleHash: support.BUNDLE_HASH,
      assertCurrent: () => service.assertPreparedIntentCurrent("development", image),
    };
    await expect(
      placements.bindPreparedEnvironment({
        ...claim,
        preparationKey: empty.profileSnapshot.runtimePreparation!.key,
      }),
    ).resolves.toBeUndefined();
    expect(store.get(environmentId)?.preparation?.consumedAtMs).toBeNull();
    support.testState.config.cloudWorkers!.profiles!.development!.settings = { region: "new" };
    await expect(
      placements.bindPreparedEnvironment({ ...claim, preparationKey: key }),
    ).rejects.toThrow("Runtime-only worker preparation changed");
    expect(store.get(environmentId)?.preparation?.consumedAtMs).toBeNull();
    support.testState.config.cloudWorkers!.profiles!.development!.settings = { region: "test" };
    await expect(
      placements.bindPreparedEnvironment({ ...claim, preparationKey: key }),
    ).resolves.toMatchObject({ state: "provisioning", environmentId });
    expect(store.get(environmentId)?.preparation?.consumedAtMs).toBe(1_000);
  });

  it("refuses unsupported image preparation rather than silently allocating cold capacity", async () => {
    const { service, provider, prepareNodeArtifacts } = fixture();
    provider.supportsProjectPreparation = () => false;
    await expect(service.prepareProjectIntent("development", imageOptions)).rejects.toThrow(
      "Worker profile cannot prepare runtime-only image capacity",
    );
    expect(prepareNodeArtifacts).not.toHaveBeenCalled();
    expect(provider.provision).not.toHaveBeenCalled();
  });

  it("rejects profile drift during artifact preparation before recording an intent", async () => {
    const { service, prepareNodeArtifacts, provider } = fixture();
    prepareNodeArtifacts.mockImplementationOnce(async () => {
      support.testState.config.cloudWorkers!.profiles!.development!.settings = { region: "new" };
      return nodeArtifacts();
    });
    await expect(service.prepareProjectIntent("development", imageOptions)).rejects.toThrow(
      "Runtime-only worker preparation changed",
    );
    expect(support.testState.store.list()).toEqual([]);
    expect(provider.provision).not.toHaveBeenCalled();
  });

  it.each(["runtime", "provider"] as const)(
    "retires image requests rejected after %s preparation before reconciliation can allocate",
    async (phase) => {
      const { service, provider, prepareNodeBootstrap } = fixture();
      const allocate = vi.fn<WorkerProvider["provision"]>(provider.provision);
      const revoke = () => {
        support.testState.config.cloudWorkers!.profiles!.development!.settings = { region: "new" };
      };
      if (phase === "runtime") {
        prepareNodeBootstrap.mockImplementationOnce(async () => {
          revoke();
          return support.NODE_BOOTSTRAP.sha256;
        });
      }
      provider.prepareProvision = async (profile, operationId, options) => {
        if (phase === "provider") {
          revoke();
        }
        return () => allocate(profile, operationId, options);
      };
      const intent = await service.prepareProjectIntent("development", imageOptions);
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "image-policy-change",
          admittedIntent: intent,
        }),
      ).rejects.toThrow("Runtime-only worker preparation changed");
      await service.reconcileOnce();
      expect(allocate).not.toHaveBeenCalled();
      expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
    },
  );

  it("settles stored image intent after reopen without selecting the changed profile", async () => {
    const { service, prepareNodeArtifacts, provider, serviceOptions } = fixture();
    const intent = await service.prepareProjectIntent("development", imageOptions);
    vi.mocked(provider.provision).mockRejectedValueOnce(new Error("Allocation reply lost"));
    await expect(
      service.createWithRequest({
        profileId: "development",
        idempotencyKey: "image-replay",
        admittedIntent: intent,
      }),
    ).rejects.toThrow("Allocation reply lost");
    const stored = support.testState.store.list()[0]!;
    expect(stored).toMatchObject({ state: "provisioning", leaseId: null });
    expect(stored.profileSnapshot.runtimePreparation).toMatchObject({ source: "image" });
    await support.reopenWorkerEnvironmentStore();
    support.testState.config.cloudWorkers!.profiles!.development!.settings = { region: "new" };
    const restartedService = support.createService(provider, serviceOptions);
    const ready = await restartedService.createWithRequest({
      profileId: "development",
      idempotencyKey: "image-replay",
    });
    expect(ready.state).toBe("ready");
    expect(
      vi
        .mocked(provider.provision)
        .mock.calls.map(([profile, operationId]) => ({ profile, operationId })),
    ).toEqual([
      { profile: { region: "test" }, operationId: stored.provisionOperationId },
      { profile: { region: "test" }, operationId: stored.provisionOperationId },
    ]);
    const resumeProvision = vi.fn<
      Parameters<typeof createWorkerProviderIntent>[0]["resumeProvision"]
    >(async (record) => record);
    const restarted = createWorkerProviderIntent({
      ...serviceOptions,
      store: support.testState.store,
      getConfig: () => support.testState.config,
      providerFor: () => provider,
      resumeProvision,
      isStopping: () => false,
      withLock: async (_id, task) => task(),
    });
    const replay = await restarted.createWithProfile("development", "image-replay", imageOptions);
    expect(replay.profileSnapshot).toEqual(stored.profileSnapshot);
    expect(resumeProvision).not.toHaveBeenCalled();
    expect(prepareNodeArtifacts).toHaveBeenCalledOnce();
    await expect(
      restarted.createWithProfile("development", "image-replay", {
        emptyWorkspace: true,
      }),
    ).rejects.toThrow("Idempotency key belongs to another project preparation");
    expect(provider.provision).toHaveBeenCalledTimes(2);
  });
});

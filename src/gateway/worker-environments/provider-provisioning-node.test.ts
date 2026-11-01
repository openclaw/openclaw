import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import type {
  WorkerNodeEnrollment,
  WorkerNodeRuntimePreparation,
  WorkerProvider,
} from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { createGatewayNodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeTunnelSupport from "./node-worker-tunnel.test-support.js";
import * as support from "./service.test-support.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

type Service = ReturnType<typeof support.createService>;
type Request = Parameters<Service["createWithRequest"]>[0];
const state = support.testState;
const closedMessage = "Worker provisioning operation is closed";
const cloneReceipt = async () => structuredClone(support.BOOTSTRAP_RECEIPT);

function create(service: Service, idempotencyKey: string, overrides: Partial<Request> = {}) {
  return service.createWithRequest({ profileId: "development", idempotencyKey, ...overrides });
}

function nodeService(
  overrides: Partial<WorkerProvider>,
  options: Parameters<typeof support.createService>[1] = {},
  requiresNodeEnrollment = true,
) {
  return support.createService(
    support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      provisionBeforeInstallation: true,
      ...(requiresNodeEnrollment ? { requiresNodeEnrollment: true } : {}),
      ...overrides,
    }),
    options,
  );
}

function resumeEnrollment(deviceId: string, displayName: string): WorkerNodeEnrollment {
  return {
    mode: "resume",
    deviceId,
    displayName,
    openclawVersion: "2026.8.1",
    nodeBootstrap: support.NODE_BOOTSTRAP,
    waitForDeviceId: async () => deviceId,
  };
}

function resultOf<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function expectAbortClosed(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({ name: "AbortError", message: closedMessage });
}

describe("node worker provider provisioning", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => closeOpenClawAgentDatabases());

  it.each([
    { target: "primary", prewarm: true },
    { target: "conversation", prewarm: false },
  ] as const)(
    "installs the verified bundle with runtime-appropriate prewarming for $target",
    async ({ target, prewarm }) => {
      const transport = nodeTunnelSupport.transport();
      const node = (await transport.listCurrentNodes())[0]!;
      node.workerHost = { enabled: true, capacity: { total: 1, available: 1 }, bundlePrewarm: 1 };
      node.commands = [];
      transport.listCurrentNodes = async () => [node];
      transport.isCurrent = (candidate) => candidate === node;
      const transfer = createNodeWorkerBundleTransferService();
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
        ok: true,
        payload: support.BOOTSTRAP_RECEIPT,
      }));
      transport.invoke = invoke;
      const ensureNodeWorkerBundle = createGatewayNodeWorkerBundleInstaller({
        log: { info: vi.fn(), warn: vi.fn() },
        gatewayNamespace: "gateway-test",
        getTransport: () => transport,
        transfer,
      });
      const service = nodeService(
        {
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          provision: async () => ({ leaseId: "cloud-lease-mode", node: { deviceId: node.nodeId } }),
        },
        { ensureNodeWorkerBundle },
        false,
      );
      try {
        const request = { profileId: "development", idempotencyKey: "runtime-mode" };
        const identity = {
          agentId: "main",
          sessionId: "conversation-mode",
          sessionKey: "agent:main:crabbox",
        };
        if (target === "conversation") {
          state.config.session = { store: path.join(state.root, "sessions.json") };
          ensureSessionEntrySync(
            { ...identity, storePath: state.config.session.store },
            { sessionId: identity.sessionId, updatedAt: 1 },
          );
        }
        const environment =
          target === "conversation"
            ? (await service.createSessionAttachment({ ...request, ...identity }, () => {}))
                .environment
            : await service.createWithRequest(request);
        expect(environment).toMatchObject({
          state: "ready",
          bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
        });
        expect(invoke).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            params: expect.objectContaining({ build: support.BOOTSTRAP_RECEIPT }),
          }),
        );
        const input = invoke.mock.calls[0]?.[0].params;
        if (prewarm) {
          expect(input).toHaveProperty("bundlePrewarm", 1);
        } else {
          expect(input).not.toHaveProperty("bundlePrewarm");
        }
      } finally {
        transfer.closeAll();
      }
    },
  );

  it.each(["bundle-failed", "provider-timeout"] as const)(
    "prepares the bundle before project-less enrollment while preserving a %s outcome",
    async (outcome) => {
      if (outcome === "provider-timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const enrolled = createDeferredCore();
      const finishProvider = createDeferredCore();
      const finishBundle = createDeferredCore();
      const bundleStarted = createDeferredCore();
      const leaseId = "cloud-lease-overlap";
      const deviceId = "cloud-device-overlap";
      const enrollment = resumeEnrollment(deviceId, "Cloud worker overlap");
      const prepareInstallation = vi.fn(async () => {
        bundleStarted.resolve();
        await finishBundle.promise;
        if (outcome === "bundle-failed") {
          throw new Error("bundle preparation failed");
        }
        return support.BUNDLE_ARTIFACT;
      });
      state.prepareInstallation = prepareInstallation;
      const closeNodeEnrollment = vi.fn();
      const ensureNodeWorkerBundle = vi.fn(cloneReceipt);
      const destroy = vi.fn(async () => {});
      let begin: (() => Promise<WorkerNodeEnrollment>) | undefined;
      const service = nodeService(
        {
          resolveAllocation: async () => ({ leaseId, sharedHost: false }),
          provision: async (_profile, _operationId, options) => {
            begin = options!.beginNodeEnrollment!;
            const [first, second] = await Promise.all([begin(), begin()]);
            expect(first).toBe(second);
            enrolled.resolve();
            await finishProvider.promise;
            return { leaseId, node: { deviceId }, sharedHost: false };
          },
          destroy,
        },
        {
          prepareNodeEnrollment: async () => enrollment,
          closeNodeEnrollment,
          ensureNodeWorkerBundle,
          ...(outcome === "provider-timeout" ? { providerCallTimeoutMs: 20 } : {}),
        },
      );
      const creation = resultOf(create(service, `bundle-overlap-${outcome}`));
      let teardown: ReturnType<typeof service.destroy> | undefined;
      try {
        await bundleStarted.promise;
        expect(begin).toBeUndefined();
        expect(state.store.list()[0]).toMatchObject({ state: "requested" });
        finishBundle.resolve();
        if (outcome === "bundle-failed") {
          expect(await creation).toMatchObject({
            error: {
              code: "bootstrap_failure",
              message: expect.stringContaining("bundle preparation failed"),
            },
          });
          expect(begin).toBeUndefined();
          expect(destroy).not.toHaveBeenCalled();
          expect(state.store.list()[0]).toMatchObject({ state: "failed" });
          return;
        }
        await Promise.race([
          enrolled.promise,
          creation.then(() => {
            throw new Error("Provisioning ended before enrollment");
          }),
        ]);
        await setImmediate();
        expect(prepareInstallation).toHaveBeenCalledExactlyOnceWith("bundle");
        expect(ensureNodeWorkerBundle).not.toHaveBeenCalled();
        const record = state.store.list()[0]!;
        expect(record).toMatchObject({ state: "provisioning", bootstrapReceipt: null });
        expect(state.store.getCredential(record.environmentId)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(20);
        expect(await creation).toMatchObject({ error: { code: "provider_failure" } });
        await expect(begin!()).rejects.toThrow(closedMessage);
        teardown = service.destroy(record.environmentId);
        await setImmediate();
        expect(destroy).not.toHaveBeenCalled();
        finishProvider.resolve();
        await expect(teardown).resolves.toMatchObject({ state: "destroyed" });
        await service.stop();
        expect(prepareInstallation).toHaveBeenCalledOnce();
      } finally {
        finishProvider.resolve();
        finishBundle.resolve();
        await Promise.allSettled([creation, teardown]);
      }
    },
  );

  it("supplies replay-safe enrollment only to providers that require it", async () => {
    const prepareNodeEnrollment = vi.fn(async (record) => {
      const enrolled = await state.store.ensureNodeEnrollment(record.environmentId);
      if (!enrolled.nodeSetupId) {
        throw new Error("expected persisted cloud enrollment ownership");
      }
      return {
        mode: "connect" as const,
        setupCode: "setup-code",
        setupId: enrolled.nodeSetupId,
        openclawVersion: "2026.8.1",
        nodeBootstrap: support.NODE_BOOTSTRAP,
        displayName: "Cloud worker test",
        waitForDeviceId: async () => "cloud-device-1",
      };
    });
    const closeNodeEnrollment = vi.fn();
    const retireNodeEnrollment = vi.fn(async () => {});
    let begin: (() => Promise<WorkerNodeEnrollment>) | undefined;
    let declaredTimeoutMs: number | undefined;
    const provision = vi.fn<WorkerProvider["provision"]>(
      async (_profile, _operationId, options) => {
        expect(options?.nodeBootstrapTimeoutMs).toBe(declaredTimeoutMs);
        begin = options?.beginNodeEnrollment;
        await expect(options?.beginNodeEnrollment?.()).resolves.toMatchObject({
          mode: "connect",
          setupId: expect.any(String),
        });
        return {
          leaseId: "cloud-lease-1",
          node: { deviceId: "cloud-device-1" },
          sharedHost: false,
        };
      },
    );
    const service = nodeService(
      {
        resolveProvisionTimeoutMs: (_profile, options) => {
          expect(prepareNodeEnrollment).not.toHaveBeenCalled();
          expect(options?.nodeBootstrapTimeoutMs).toBe(105 * 60_000);
          declaredTimeoutMs = options?.nodeBootstrapTimeoutMs;
          return declaredTimeoutMs ?? 1;
        },
        provision,
      },
      {
        prepareNodeEnrollment,
        closeNodeEnrollment,
        retireNodeEnrollment,
        ensureNodeWorkerBundle: cloneReceipt,
      },
    );

    const environment = await create(service, "request-cloud-node");
    expect(environment).toMatchObject({
      state: "ready",
      nodeSetupId: expect.any(String),
      nodeDeviceId: "cloud-device-1",
      sharedHost: false,
    });
    expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(closeNodeEnrollment).toHaveBeenCalledExactlyOnceWith(
      await prepareNodeEnrollment.mock.results[0]!.value,
    );
    await expect(begin!()).rejects.toThrow(closedMessage);
    expect(prepareNodeEnrollment).toHaveBeenCalledOnce();

    await expect(service.destroy(environment.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
    expect(retireNodeEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSetupId: environment.nodeSetupId,
        nodeDeviceId: "cloud-device-1",
        state: "destroying",
      }),
    );
  });

  it("prepares the node runtime before allocation when preparation ends in teardown", async () => {
    const entered = createDeferredCore();
    const prepared = createDeferredCore();
    const provision = vi.fn(async () => {
      entered.resolve();
      return {
        leaseId: "cloud-lease-prepared",
        node: { deviceId: "cloud-device-prepared" },
        sharedHost: false,
      };
    });
    const service = nodeService(
      { provision },
      {
        ensureNodeWorkerBundle: cloneReceipt,
        prepareNodeBootstrap: async () => {
          entered.resolve();
          await prepared.promise;
          return support.NODE_BOOTSTRAP.sha256;
        },
        prepareNodeEnrollment: async () => {
          throw new Error("provider does not need enrollment in this case");
        },
      },
    );
    const completed = resultOf(create(service, "request-node-preparation-teardown"));
    try {
      await entered.promise;
      expect(provision).not.toHaveBeenCalled();
      const record = state.store.list()[0]!;
      expect(record.state).toBe("requested");
      await state.store.requestDestroy({ environmentId: record.environmentId, state: "requested" });
      prepared.resolve();
      expect(await completed).toMatchObject({
        error: { message: expect.stringContaining("changed during bootstrap preparation") },
      });
      expect(provision).not.toHaveBeenCalled();
    } finally {
      prepared.resolve();
      await completed;
    }
  });

  it.each(["provider-timeout", "enrollment-timeout", "runtime-timeout"] as const)(
    "closes the exact enrollment and rejects retained callbacks after %s",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const providerEntered = createDeferredCore();
      const finishProvider = createDeferredCore();
      const finishEnrollment = createDeferredCore<WorkerNodeEnrollment>();
      const finishRuntime = createDeferredCore<WorkerNodeRuntimePreparation>();
      const runtime: WorkerNodeRuntimePreparation = {
        nodeBootstrap: support.NODE_BOOTSTRAP,
        workerBundle: {
          ...support.NODE_BOOTSTRAP,
          packageRelativePath: `worker-artifacts/${support.NODE_BOOTSTRAP.sha256}.tgz`,
        },
      };
      let runtimeSignal: AbortSignal | undefined;
      const prepareNodeRuntime = vi.fn(async (_record, _bundle, signal?: AbortSignal) => {
        runtimeSignal = signal;
        if (outcome === "runtime-timeout") {
          providerEntered.resolve();
          return await finishRuntime.promise;
        }
        return runtime;
      });
      const closeNodeRuntime = vi.fn();
      const enrollment = resumeEnrollment("cloud-device-closed", "Cloud worker lifecycle");
      const prepareNodeEnrollment = vi.fn(async () => {
        if (outcome === "enrollment-timeout") {
          providerEntered.resolve();
          return await finishEnrollment.promise;
        }
        return enrollment;
      });
      const closeNodeEnrollment = vi.fn();
      let begin: (() => Promise<WorkerNodeEnrollment>) | undefined;
      let pendingEnrollment: Promise<WorkerNodeEnrollment> | undefined;
      let prepareRuntime: (() => Promise<WorkerNodeRuntimePreparation>) | undefined;
      let pendingRuntime: Promise<WorkerNodeRuntimePreparation> | undefined;
      const service = nodeService(
        {
          provision: async (_profile, _operationId, options) => {
            begin = options!.beginNodeEnrollment!;
            prepareRuntime = options!.prepareNodeRuntime!;
            pendingRuntime = prepareRuntime();
            await pendingRuntime;
            pendingEnrollment = begin();
            await pendingEnrollment;
            providerEntered.resolve();
            await finishProvider.promise;
            return { leaseId: "cloud-lease-closed", node: { deviceId: "cloud-device-closed" } };
          },
        },
        {
          prepareNodeRuntime,
          closeNodeRuntime,
          prepareNodeEnrollment,
          closeNodeEnrollment,
          providerCallTimeoutMs: 20,
        },
      );
      const creationResult = resultOf(create(service, `request-node-closed-${outcome}`));
      try {
        await Promise.race([
          providerEntered.promise,
          creationResult.then((result) => {
            throw new Error("Provisioning ended before the expected provider stage", {
              cause: result,
            });
          }),
        ]);
        await vi.advanceTimersByTimeAsync(20);
        expect(await creationResult).toMatchObject({ error: { code: "provider_failure" } });
        expect(runtimeSignal?.aborted).toBe(true);
        if (outcome === "runtime-timeout") {
          const lateRejected = expect(pendingRuntime).rejects.toThrow(closedMessage);
          finishRuntime.resolve(runtime);
          await lateRejected;
        }
        if (outcome === "enrollment-timeout") {
          const lateRejected = expect(pendingEnrollment).rejects.toThrow(closedMessage);
          finishEnrollment.resolve(enrollment);
          await lateRejected;
        }
        await expectAbortClosed(begin!());
        await expectAbortClosed(prepareRuntime!());
        expect(closeNodeRuntime).toHaveBeenCalledExactlyOnceWith(runtime);
        expect(prepareNodeRuntime).toHaveBeenCalledOnce();
        expect(state.prepareInstallation).toHaveBeenCalledExactlyOnceWith("bundle");
        if (outcome === "runtime-timeout") {
          expect(closeNodeEnrollment).not.toHaveBeenCalled();
          expect(prepareNodeEnrollment).not.toHaveBeenCalled();
        } else {
          expect(closeNodeEnrollment).toHaveBeenCalledExactlyOnceWith(enrollment);
          expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
        }
      } finally {
        finishEnrollment.resolve(enrollment);
        finishRuntime.resolve(runtime);
        finishProvider.resolve();
        await creationResult;
      }
    },
  );

  it("destroys an unreported node allocation without reenrolling or admitting its worker", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.root);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const leaseId = "cloud-lease-destroy-replay";
    const deviceId = "cloud-device-destroy-replay";
    const operationIds: string[] = [];
    const ensureNodeWorkerBundle = vi.fn(cloneReceipt);
    const generateWorkerCredential = vi.fn(() => support.CREDENTIAL);
    const retireNodeEnrollment = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});
    const transport = nodeTunnelSupport.transport();
    const listNodes = vi.fn(async () => []);
    transport.listCurrentNodes = listNodes;
    const invoke = vi.spyOn(transport, "invoke");
    const workspaceTransfer = nodeTunnelSupport.workspaceTransfer();
    workspaceTransfer.closeAll = vi.fn(async () => {});
    const nodeTunnels = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-1",
      getEnvironment: (id) => state.store.get(id),
      listEnvironments: () => state.store.list(),
      getTransport: () => transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => false,
      workspaceTransfer,
    });
    const stop = vi.spyOn(nodeTunnels, "stop");
    const transitions = vi.spyOn(state.store, "transition");
    const enrollmentManager = createWorkerNodeEnrollmentManager({
      store: state.store,
      getConfig: () => ({
        gateway: {
          publicOrigin: "https://gateway.example.test",
          auth: { mode: "token", token: "gateway-token" },
        },
      }),
      resolveAvailability: async () => ({ available: false }),
      prepareArtifact: async () => ({
        tarballPath: path.join(state.root, "node-runtime.tgz"),
        tarballSha256: support.NODE_BOOTSTRAP.sha256,
        tarballBytes: 1,
        openclawVersion: "2026.8.1",
        buildId: "gateway-source-build",
        enabledPluginIds: [],
      }),
      transfer: createWorkerBootstrapArtifactTransferService(),
    });
    onTestFinished(() => enrollmentManager.stop());
    const prepareNodeEnrollment = vi.fn(enrollmentManager.begin);
    const service = nodeService(
      {
        resolveAllocation: async () => ({ leaseId, sharedHost: false }),
        provision: async (_profile, operationId, options) => {
          operationIds.push(operationId);
          const enrollment = await options?.beginNodeEnrollment?.();
          if (enrollment?.mode !== "connect") {
            throw new Error("expected pending enrollment");
          }
          const { bootstrapToken: token } = decodePairingSetupCode(enrollment.setupCode);
          await expect(
            verifyDeviceBootstrapToken({
              token,
              deviceId,
              publicKey: "cloud-public-key-destroy-replay",
              role: "node",
              scopes: [],
            }),
          ).resolves.toEqual({ ok: true });
          await expect(
            consumeDeviceBootstrapTokenWithSetupCompletion({
              token,
              deviceId,
              completedAtMs: 1_000,
              admitsCloudWorkerSetup: enrollmentManager.admitsNodeSetupCompletion,
            }),
          ).resolves.toMatchObject({ completion: { setupId: enrollment.setupId, deviceId } });
          throw new Error("provider response was lost after node allocation");
        },
        destroy,
      },
      {
        prepareNodeEnrollment,
        closeNodeEnrollment: enrollmentManager.close,
        retireNodeEnrollment,
        ensureNodeWorkerBundle,
        generateWorkerCredential,
        nodeTunnelManager: nodeTunnels,
      },
    );

    await expect(create(service, "request-node-destroy-replay")).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("provider response was lost after node allocation"),
    });
    const provisioning = state.store.list()[0]!;
    expect(provisioning).toMatchObject({
      state: "provisioning",
      leaseId: null,
      nodeSetupId: expect.any(String),
      nodeDeviceId: deviceId,
    });

    state.providersEnabled = false;
    await expect(service.destroy(provisioning.environmentId)).rejects.toMatchObject({
      code: "provider_not_found",
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(provisioning.environmentId, 0, undefined);
    expect(state.store.get(provisioning.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      nodeDeviceId: deviceId,
      destroyRequestedAtMs: expect.any(Number),
    });
    expect(destroy).not.toHaveBeenCalled();

    state.providersEnabled = true;
    await expect(service.destroy(provisioning.environmentId)).resolves.toMatchObject({
      state: "destroyed",
      leaseId,
      nodeDeviceId: deviceId,
      sharedHost: false,
      desktop: null,
    });

    expect(operationIds).toEqual([provisioning.provisionOperationId]);
    expect(listNodes).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
    expect(ensureNodeWorkerBundle).not.toHaveBeenCalled();
    expect(state.prepareInstallation).toHaveBeenCalledExactlyOnceWith("bundle");
    expect(state.bootstrapWorker).not.toHaveBeenCalled();
    expect(generateWorkerCredential).not.toHaveBeenCalled();
    expect(state.store.getCredential(provisioning.environmentId)).toBeUndefined();
    expect(transitions).not.toHaveBeenCalledWith(expect.objectContaining({ to: "ready" }));
    expect(destroy).toHaveBeenCalledExactlyOnceWith({
      leaseId,
      profile: { region: "test" },
      assertCurrent: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(retireNodeEnrollment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        state: "destroying",
        leaseId,
        nodeSetupId: provisioning.nodeSetupId,
        nodeDeviceId: deviceId,
        sharedHost: false,
        desktop: null,
        bootstrapReceipt: null,
        ownerEpoch: 0,
      }),
    );
    expect(state.store.get(provisioning.environmentId)).toMatchObject({
      state: "destroyed",
      bootstrapReceipt: null,
      ownerEpoch: 0,
    });
    expect(
      service.takeMintedCredential({
        environmentId: provisioning.environmentId,
        ownerEpoch: 0,
        sessionId: null,
      }),
    ).toBeUndefined();
  });

  it("keeps paired-device roles when a node lease has no cloud enrollment owner", async () => {
    const retireNodeEnrollment = vi.fn(async () => {});
    const service = nodeService(
      {
        provision: async () => ({
          leaseId: "device-lease-1",
          node: { deviceId: "paired-device-1" },
          sharedHost: true,
        }),
      },
      { retireNodeEnrollment, ensureNodeWorkerBundle: cloneReceipt },
      false,
    );

    const environment = await create(service, "request-paired-device");
    expect(environment).toMatchObject({
      state: "ready",
      nodeSetupId: null,
      nodeDeviceId: "paired-device-1",
    });

    await expect(service.destroy(environment.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
    expect(retireNodeEnrollment).not.toHaveBeenCalled();
  });
});

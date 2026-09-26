import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createDeviceWorkerRuntime } from "../worker-environments/device-provider.js";
import type { WorkerPlacementDispatchService } from "../worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { createWorkerEnvironmentService } from "../worker-environments/service.js";
import { BUNDLE_ARTIFACT, BOOTSTRAP_RECEIPT } from "../worker-environments/service.test-support.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import {
  dispatchTestSessionKey,
  getSessionDispatchHandler,
  invokeSessionDispatch,
  makeDispatchTestContext,
} from "./sessions-dispatch.test-support.js";
import type { GatewayClient } from "./types.js";

type DeviceFixture = {
  makeTempDir: (prefix: string) => string;
  connectedNode: (deviceId: string, available: number) => NodeWorkerSupervisorNodeProof;
  pairedNode: (deviceId: string) => PairedDevice;
  useDeviceSession: () => void;
  activeDevicePlacement: (
    deviceId: string,
  ) => Extract<WorkerSessionPlacementRecord, { state: "active" }>;
};
export function registerNativeDeviceDispatchTests({
  makeTempDir,
  connectedNode,
  pairedNode,
  useDeviceSession,
  activeDevicePlacement,
}: DeviceFixture): void {
  it("admits a named native device profile with admin authority and preserves its provider snapshot", async () => {
    const root = makeTempDir("openclaw-dispatch-named-native-device-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const store = await createWorkerEnvironmentStore({ database });
    const config = {
      cloudWorkers: {
        profiles: {
          "dedicated-native": {
            provider: "device",
            settings: { device: "scenario2-paired-node", inference: "runtime-local" },
          },
        },
      },
    };
    const node = connectedNode("scenario2-paired-node", 2);
    const runtime = createDeviceWorkerRuntime({
      getPairedDevice: async (id) => (id === node.nodeId ? pairedNode(id) : null),
    });
    runtime.bindNodeTransport({
      getCurrentNode: async (id) => (id === node.nodeId ? node : undefined),
      listCurrentNodes: async () => [node],
      hasCurrentRunner: () => true,
      isCurrent: (candidate) => candidate === node,
      invoke: async () => ({ ok: false }),
    });
    const provision = vi.spyOn(runtime.provider, "provision");
    const bootstrapWorker = vi.fn();
    const ensureNodeWorkerBundle = vi.fn(async () => BOOTSTRAP_RECEIPT);
    const service = createWorkerEnvironmentService({
      store,
      scheduler: createTestGatewayScheduler(),
      getConfig: () => config,
      resolveProvider: (id) => (id === "device" ? runtime.provider : undefined),
      prepareInstallation: async () => BUNDLE_ARTIFACT,
      bootstrapWorker,
      ensureNodeWorkerBundle,
      executeInference: vi.fn(),
    });
    const previousRegistry = getActivePluginRegistry();
    // Core device placement must not require a fabricated plugin owner/manifest.
    setActivePluginRegistry(createEmptyPluginRegistry(), "named-native-device", "default");
    try {
      useDeviceSession();
      // Exercise RPC admission and the real profile/provider lifecycle; workspace sync
      // and placement activation remain the existing dispatch fixture boundary.
      const dispatch = vi.fn<WorkerPlacementDispatchService["dispatch"]>(
        async (request, _onTransition, authorize) => {
          authorize?.();
          const intent = await service.prepareProjectIntent(request.profileId, {
            executionMode: request.executionMode,
            runSetupScript: request.runSetupScript,
          });
          expect(intent).toMatchObject({
            providerId: "device",
            profileSnapshot: {
              executionMode: "worker-turn",
              settings: { device: node.nodeId, inference: "runtime-local" },
            },
          });
          expect(intent.profileSnapshot.settings).not.toBe(
            config.cloudWorkers.profiles["dedicated-native"].settings,
          );
          authorize?.();
          const environment = await service.createWithRequest({
            profileId: request.profileId,
            idempotencyKey: "scenario2-named-device",
            executionMode: request.executionMode,
            runSetupScript: request.runSetupScript,
            admittedIntent: intent,
          });
          expect(environment).toMatchObject({
            providerId: "device",
            profileId: "dedicated-native",
            nodeDeviceId: node.nodeId,
            sharedHost: true,
            sshEndpoint: null,
            profileSnapshot: { settings: { device: node.nodeId, inference: "runtime-local" } },
          });
          return {
            ...activeDevicePlacement(node.nodeId),
            environmentId: environment.environmentId,
          };
        },
      );
      const context = makeDispatchTestContext({
        getRuntimeConfig: () => config,
        logGateway: { warn: vi.fn() } as never,
        workerEnvironmentService: service,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      });
      const request = async (scope: "operator.write" | "operator.admin") => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: `scenario2-${scope}`,
            method: "sessions.dispatch",
            params: { key: dispatchTestSessionKey, profileId: "dedicated-native" },
          },
          respond,
          context,
          isWebchatConnect: () => false,
          client: {
            connId: `scenario2-${scope}`,
            connect: {
              role: "operator",
              scopes: [scope],
              client: { id: "test", version: "1", platform: "test", mode: "test" },
              minProtocol: 1,
              maxProtocol: 1,
            },
          } as GatewayClient,
          extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
        });
        return respond;
      };
      const denied = await request("operator.write");
      expect(denied).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          details: expect.objectContaining({ missingScope: "operator.admin" }),
        }),
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(store.list()).toEqual([]);

      const accepted = await request("operator.admin");
      expect(accepted).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        profileId: "dedicated-native",
        executionMode: "worker-turn",
        runSetupScript: true,
      });
      expect(provision).toHaveBeenCalledExactlyOnceWith(
        { device: node.nodeId, inference: "runtime-local" },
        expect.any(String),
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(ensureNodeWorkerBundle).toHaveBeenCalledOnce();
      expect(bootstrapWorker).not.toHaveBeenCalled();
      config.cloudWorkers.profiles["dedicated-native"].settings.inference = "gateway";
      expect(store.list()[0]?.profileSnapshot.settings).toEqual({
        device: node.nodeId,
        inference: "runtime-local",
      });
    } finally {
      await service.stop();
      closeOpenClawStateDatabaseForTest();
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry, "named-native-device-restore", "default");
      } else {
        resetPluginRuntimeStateForTest();
      }
      vi.restoreAllMocks();
    }
  });

  it("synthesizes the core device-provider target for a connected session-capable node", async () => {
    useDeviceSession();
    const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("device-1"));
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "device:device-1",
        deviceId: "device-1",
        inheritedProfile: {
          providerId: "device",
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });
}

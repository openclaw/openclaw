// Register tool mocks before loading dispatch/runtime dependencies.
import "./worker-session-tool-executor.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { hashWorkerCredential } from "./credential.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { createWorkerEnvironmentStore } from "./store.js";
const { CHILD, SOURCE, installWorkerSessionToolTestFixture, workerSessionToolTestMocks } =
  await import("./worker-session-tool-executor.test-support.js");

const mocks = workerSessionToolTestMocks();
const features = [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE];
const bundleHash = "a".repeat(64);
const preparationKey = "c".repeat(64);

describe("worker child dispatch prepared allocation", () => {
  const fixture = installWorkerSessionToolTestFixture(mocks);

  function prepare() {
    const current = fixture();
    const now = Date.now();
    const store = createWorkerEnvironmentStore({ database: current.database, now: () => now });
    const selected = deriveEnvironmentIntent("prepared:child-regression");
    const intent: WorkerProviderPreparedIntent = {
      providerId: "fake",
      preparationKey,
      profileSnapshot: {
        install: "bundle",
        settings: { region: "source" },
        executionMode: "worker-turn",
        project: {
          key: "d".repeat(64),
          root: "/gateway/workspace",
          baseCommit: "e".repeat(40),
          preparation: {
            key: preparationKey,
            cacheKey: "a".repeat(64),
            contractVersion: 1,
            target: { machineClass: "standard", platform: "linux", arch: "x64" },
            artifacts: {
              nodeBootstrapSha256: "f".repeat(64),
              enabledPluginIds: [],
              workerBundleHash: bundleHash,
              workerArchiveSha256: "b".repeat(64),
              openclawVersion: "2026.7.2",
              protocolFeatures: features,
            },
          },
        },
      },
    };
    store.createIntent({
      ...selected,
      providerId: "fake",
      profileId: "cloud-profile",
      profileSnapshot: intent.profileSnapshot,
      preparation: {
        purpose: "reserve",
        key: preparationKey,
        demandAtMs: now - 100,
        expiresAtMs: now + 60_000,
      },
    });
    store.transition({
      environmentId: selected.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const credential = {
      credentialHash: hashWorkerCredential("prepared-fixture"),
      sessionId: null,
      rpcSetVersion: 1,
      expiresAtMs: now + 60_000,
    };
    store.transition({
      environmentId: selected.environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "prepared-lease",
        nodeDeviceId: "prepared-node",
        sharedHost: false,
        bootstrapReceipt: { bundleHash, openclawVersion: "2026.7.2", protocolFeatures: features },
        credential,
      },
    });
    const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
      () => new NodeRegistry({ getConfig: getRuntimeConfig }),
    );
    nodeRegistry.register(
      {
        connId: "prepared-connection",
        usesSharedGatewayAuth: false,
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
        } as unknown as GatewayWsClient["socket"],
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "test",
            platform: "linux",
            mode: GATEWAY_CLIENT_MODES.NODE,
          },
          device: {
            id: "prepared-node",
            publicKey: "fixture",
            signature: "fixture",
            signedAt: 1,
            nonce: "fixture",
          },
          commands: [],
        },
      },
      { pairingIdentity: "prepared-identity", pairingGeneration: "prepared-generation" },
    );
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId: "prepared-node",
      connId: "prepared-connection",
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 1, available: 1 },
          environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
          preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION,
        },
      },
    });
    onTestFinished(() => {
      nodeRegistry.unregister("prepared-connection");
    });
    const harness = createHarness(current.database, current.placements, {
      isCurrentNodePlacement: (proof, requirement) =>
        transport.isCurrent(
          proof,
          requirement.consumesWorkerSlot,
          requirement.requiredNodeCommands,
        ),
    });
    const project = (id: string) => {
      const record = store.get(id);
      return record
        ? { ...record, desktopAvailable: false, desktopApps: [], tunnelStatus: "stopped" as const }
        : undefined;
    };
    vi.mocked(harness.environments.get).mockImplementation(project);
    vi.mocked(harness.environments.prepareProjectIntent).mockResolvedValue(intent);
    vi.mocked(harness.environments.getPreparedCandidates).mockImplementation(() => {
      const candidate = project(selected.environmentId);
      return candidate?.state === "ready" && candidate.preparation?.consumedAtMs === null
        ? [candidate]
        : [];
    });
    vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
      request.authorize?.();
      const attached = store.transition({
        environmentId: request.environmentId,
        from: "ready",
        to: "attached",
        expectedOwnerEpoch: request.ownerEpoch,
        placementBinding: request.placementBinding,
        patch: {
          attachedSessionIds: [request.sessionId],
          credential: { ...credential, sessionId: request.sessionId },
        },
      });
      return {
        credential: "prepared-fixture",
        deliveryId: "prepared-delivery",
        environmentId: attached.environmentId,
        bundleHash,
        sessionId: request.sessionId,
        rpcSetVersion: 1,
        ownerEpoch: attached.ownerEpoch,
        expiresAtMs: now + 60_000,
      };
    });
    const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
    vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => ({
      ...(await startTunnel({ ...request, ownerEpoch: harness.ready.ownerEpoch })),
      environmentId: request.environmentId,
      ownerEpoch: request.ownerEpoch,
    }));
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: (await transport.listCurrentNodes())[0],
    }));
    const originalGet = current.environments.get.getMockImplementation()!;
    let replacementProvision: string | undefined;
    current.environments.get.mockImplementation((id) => {
      if (id === SOURCE.environmentId) {
        const source = originalGet(id)!;
        return {
          ...source,
          profileSnapshot: { ...source.profileSnapshot, executionMode: "worker-turn" },
        };
      }
      const selectedRecord = project(id);
      return selectedRecord && replacementProvision
        ? { ...selectedRecord, provisionOperationId: replacementProvision }
        : selectedRecord;
    });
    current.setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    return {
      current,
      harness,
      store,
      selected,
      replaceProvision: () => {
        replacementProvision = "replacement-full-provision-id";
      },
    };
  }

  it.each([false, true])(
    "hands off the exact consumed reserve (dispatch reply lost=%s)",
    async (loseReply) => {
      const { current, harness, store, selected } = prepare();
      mocks.dispatchChild.mockImplementation(async (request, observer, authorize) => {
        const result = await harness.service.dispatch(request, observer, authorize);
        if (loseReply) {
          throw new Error("dispatch reply lost");
        }
        return result;
      });
      const result = await current.spawn("prepared-spawn");
      expect(result.resultJson).toContain("spawned-child-run");
      expect(current.placements.get(CHILD.sessionId)).toMatchObject({
        state: "active",
        environmentId: selected.environmentId,
      });
      expect(store.get(selected.environmentId)?.preparation?.consumedAtMs).toEqual(
        expect.any(Number),
      );
      expect(
        deriveEnvironmentIntent(mocks.dispatchChild.mock.calls[0]![0].idempotencyKey),
      ).not.toEqual(selected);
      expect(harness.environments.create).not.toHaveBeenCalled();
      expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
      expect(mocks.gatewayRequest).toHaveBeenCalledOnce();
      expect((await current.spawn("prepared-spawn")).resultJson).toBe(result.resultJson);
      expect(mocks.dispatchChild).toHaveBeenCalledOnce();
    },
  );

  it("does not adopt a reserve from only a later active row", async () => {
    const { current, harness } = prepare();
    mocks.dispatchChild.mockImplementation((request, _observer, authorize) =>
      harness.service.dispatch(request, undefined, authorize),
    );
    expect((await current.spawn("unobserved-reserve")).resultJson).toContain("outcome is unknown");
    expect(mocks.gatewayRequest).not.toHaveBeenCalled();
  });

  it("does not retry initial admission against a replaced full provision identity", async () => {
    const { current, harness, replaceProvision } = prepare();
    mocks.dispatchChild.mockImplementation((request, observer, authorize) =>
      harness.service.dispatch(request, observer, authorize),
    );
    mocks.gatewayRequest.mockImplementationOnce(async () => {
      replaceProvision();
      throw new Error("initial admission reply lost");
    });
    expect((await current.spawn("replaced-reserve")).resultJson).toContain("outcome is unknown");
    expect(mocks.gatewayRequest).toHaveBeenCalledOnce();
  });
});

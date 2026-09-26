import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { createWorkerNodePortalCarrier } from "../worker-environments/portal-node-carrier.js";
import {
  fakePortalBroker,
  pendingPortalTransport,
  portalNodeProof,
} from "../worker-environments/portal-node-carrier.test-support.js";
import * as support from "../worker-environments/service.test-support.js";
import { portalHandlers } from "./portals.js";

describe("session Portal RPC policy admission", () => {
  it.each(["operator.write", "operator.sessions.write"])(
    "rejects a locked canonical session through the actual router under %s",
    async (scope) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        const writer = await ensureCanonicalUserProfileForEmail("portal-writer@example.test");
        const sessionKey = "agent:main:preview";
        const projection = createSessionRowProjectionFixture({
          cfg: {},
          store: {
            [sessionKey]: {
              sessionId: "conversation",
              lifecycleRevision: "incarnation",
              updatedAt: 1,
              modelSelectionLocked: true,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: writer.id },
            },
          },
        });
        const context = bindSessionRowProjection(createContext(), () => projection);
        const method = "portal.session.open";
        const handler = vi.fn(portalHandlers[method]!);
        const methodRegistry = createGatewayMethodRegistry(
          createCoreGatewayMethodDescriptors({ [method]: handler }),
        );
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "locked-preview",
            method,
            params: { sessionKey, environmentId: "attached", port: 3000 },
          },
          client: createOperatorClient({ profileId: writer.id, scopes: [scope] }),
          context,
          methodRegistry,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: expect.stringContaining("locked model selection"),
            details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
          }),
        );
        expect(handler).not.toHaveBeenCalled();
      }),
  );
});

describe("session Portal authority through worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits its writer, denies an unrelated writer, and fences withdrawn qualification before node I/O", async () => {
    const environment = captureEnv(["OPENCLAW_STATE_DIR"]);
    onTestFinished(() => environment.restore());
    setTestEnvValue("OPENCLAW_STATE_DIR", support.testState.root);
    const writer = await ensureCanonicalUserProfileForEmail("portal-writer@example.test");
    const unrelated = await ensureCanonicalUserProfileForEmail("portal-unrelated@example.test");
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:preview",
      sessionId: "conversation",
    };
    const environmentId = "preview-machine";
    const { store, config } = support.testState;
    await store.createSessionAttachmentIntent(
      {
        ...identity,
        environmentId,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: "provision-preview",
      },
      () => {},
    );
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    const record = await store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "preview-lease",
        nodeDeviceId: "preview-node",
        sshEndpoint: null,
        sharedHost: false,
        ...support.readyPatch(environmentId),
      },
    });
    const proof = portalNodeProof(record.nodeDeviceId!);
    const transport = pendingPortalTransport({ proof, isProofCurrent: () => true });
    const broker = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: broker.broker });
    let sharedHost: boolean | undefined = false;
    const environments = support.createService(
      support.createProvider({
        resolveAllocation: async () => ({ leaseId: "preview-lease", sharedHost: false }),
        inspect: async () => ({ status: "active", sharedHost }),
      }),
      { nodePortalCarrier: carrier },
    );
    await environments.reconcileOnce(environmentId);
    const qualification = environments.getDedicatedNodeLeaseSignal(environmentId)!;
    expect(qualification.aborted).toBe(false);
    const projection = createSessionRowProjectionFixture({
      cfg: config,
      store: {
        [identity.sessionKey]: {
          sessionId: identity.sessionId,
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: writer.id },
        },
      },
    });
    const portals = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers: [] });
    const open = vi.spyOn(portals, "open");
    const context = bindSessionRowProjection(createContext(), () => projection);
    Object.assign(context, {
      workerEnvironmentService: environments,
      portalService: portals,
      getRuntimeConfig: () => config,
      broadcast: vi.fn(),
    });
    const method = "portal.session.open";
    const methodRegistry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({ [method]: portalHandlers[method]! }),
    );
    const invoke = async (profileId: string) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: profileId,
          method,
          params: { sessionKey: identity.sessionKey, environmentId, port: 3000 },
        },
        client: createOperatorClient({ profileId, scopes: ["operator.sessions.write"] }),
        context,
        methodRegistry,
        respond,
        isWebchatConnect: () => false,
      });
      return respond.mock.calls[0];
    };
    try {
      expect((await invoke(unrelated.id))?.[0]).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(transport.invoke).not.toHaveBeenCalled();
      expect((await invoke(writer.id))?.[0]).toBe(true);
      const target = open.mock.calls[0]?.[0].target;
      if (target?.kind !== "worker") {
        throw new Error("missing worker preview");
      }
      const invoked = createDeferred();
      const originalInvoke = transport.invoke.getMockImplementation()!;
      transport.invoke.mockImplementation((request) => {
        invoked.resolve();
        return originalInvoke(request);
      });
      support.testState.nowMs += 100;
      const connection = target.connect();
      await invoked.promise;
      const stream = broker.attachNext();
      expect(await connection).toBe(stream);
      expect(store.getSessionAttachmentRecord(identity.sessionId)?.lastUsedAtMs).toBe(
        support.testState.nowMs,
      );
      const discovering = createDeferred();
      const discover = createDeferred();
      vi.spyOn(transport.transport, "getCurrentNode").mockImplementationOnce(async () => {
        discovering.resolve();
        await discover.promise;
        return proof;
      });
      const pending = target.connect().then(
        () => false,
        () => true,
      );
      await discovering.promise;
      const persisting = createDeferred();
      const persist = createDeferred();
      const originalPersist = store.reconcileSharedHost.bind(store);
      vi.spyOn(store, "reconcileSharedHost").mockImplementationOnce(async (input) => {
        persisting.resolve();
        await persist.promise;
        return originalPersist(input);
      });
      sharedHost = undefined;
      const reconciliation = environments.reconcileOnce(environmentId);
      try {
        await persisting.promise;
        expect(qualification.aborted).toBe(true);
        expect(portals.list()).toEqual([]);
      } finally {
        discover.resolve();
        persist.resolve();
        await reconciliation;
      }
      expect(await pending).toBe(true);
      expect(transport.invoke).toHaveBeenCalledOnce();
      expect(stream.destroyed).toBe(true);
    } finally {
      await portals.closeAll();
    }
  });
});

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  ensureSessionEntrySync,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  environmentsSessionHandlers,
  resolveSessionEnvironmentCaller,
} from "../server-methods/environments.session.js";
import { portalHandlers } from "../server-methods/portals.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import * as support from "./service.test-support.js";

describe("conversation-owned temporary environments", () => {
  support.setupWorkerEnvironmentServiceSuite();
  const identity = {
    sessionId: "conversation-one",
    sessionKey: "agent:main:crabbox",
    agentId: "main",
  };
  const request = { ...identity, profileId: "development", idempotencyKey: "open-desktop" };
  const authorize = () => {};
  const scope = () => ({
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    storePath: support.testState.config.session!.store,
  });

  beforeEach(() => {
    support.testState.config.session = {
      store: path.join(support.testState.root, "sessions.json"),
    };
    ensureSessionEntrySync(scope(), { sessionId: identity.sessionId, updatedAt: 1 });
  });
  afterEach(() => closeOpenClawAgentDatabases());

  it("admits the actual plugin RPC through ambient run authority and fences a retained caller after revocation", async () => {
    const service = support.createService(support.createProvider());
    const respond = vi.fn();
    const context = createDirectChatContext({
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: service,
    });
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "request-one", method: "environments.session.create" },
      params: { profileId: request.profileId, idempotencyKey: request.idempotencyKey },
      context,
      client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
      isWebchatConnect: () => false,
      respond,
    };
    expect(() => resolveSessionEnvironmentCaller(options)).toThrow(
      "authenticated operator or admitted agent run",
    );
    let live = true;
    await withGatewayToolCallerIdentity(
      {
        ...identity,
        operationalRunInstance: { instanceId: "run-instance", runId: "run-one" },
        receiptAuthority: () => live,
      },
      async () => {
        const caller = resolveSessionEnvironmentCaller(options);
        expect(() =>
          resolveSessionEnvironmentCaller(options, { sessionKey: "agent:main:other" }),
        ).toThrow("only manage its own");
        await environmentsSessionHandlers["environments.session.create"]!(options);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            environment: expect.objectContaining({ status: "available" }),
          }),
        );
        live = false;
        expect(caller.assertCurrent).toThrow("no longer active");
      },
    );
  });

  it("opens a portal through ambient plugin authority and closes an unused carrier when that authority ends", async () => {
    const service = support.createService(support.createProvider());
    const created = await service.createSessionAttachment(request, authorize);
    const portalService = createGatewayPortalService({
      httpBindHosts: ["127.0.0.1"],
      httpServers: [],
    });
    const closeConnection = vi.fn(async () => {});
    let live = true;
    let revokeDuringDiscovery = false;
    const openNodePortal = vi.spyOn(service, "openNodePortal").mockImplementation(async () => {
      if (revokeDuringDiscovery) {
        live = false;
      }
      return { connect: vi.fn(), close: closeConnection };
    });
    const context = createDirectChatContext({
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: service,
      portalService,
      broadcast: vi.fn(),
    });
    const invoke = async (environmentId: string, port: number) => {
      const respond = vi.fn();
      await portalHandlers["portal.open"]!({
        req: { type: "req", id: "portal-one", method: "portal.open" },
        params: { environmentId, port },
        context,
        client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
        isWebchatConnect: () => false,
        respond,
      });
      return respond;
    };
    try {
      await withGatewayToolCallerIdentity(
        {
          ...identity,
          operationalRunInstance: { instanceId: "portal-instance", runId: "portal-run" },
          receiptAuthority: () => live,
          gatewayContextResolver: () => context,
        },
        async () => {
          const opened = await invoke(created.attachment.environmentId, 3000);
          expect(opened.mock.calls[0]?.[0]).toBe(true);
          expect(
            portalService.listWorkerPortals(
              created.attachment.environmentId,
              created.attachment.ownerEpoch,
            ),
          ).toHaveLength(1);
          expect((await invoke("worker:another-conversation", 3000)).mock.calls[0]?.[0]).toBe(
            false,
          );
          expect(openNodePortal).toHaveBeenCalledTimes(1);
          revokeDuringDiscovery = true;
          expect((await invoke(created.attachment.environmentId, 3001)).mock.calls[0]?.[0]).toBe(
            false,
          );
          expect(closeConnection).toHaveBeenCalledOnce();
          expect(portalService.list()).toHaveLength(1);
        },
      );
    } finally {
      await portalService.closeAll();
    }
  });

  it.each([
    { presentation: "desktop", deniedBy: "captured" },
    { presentation: "portal", deniedBy: "live" },
    { presentation: "desktop", deniedBy: "missing" },
  ] as const)(
    "does not reserve or allocate a machine when $presentation presentation lacks $deniedBy screen authority",
    async ({ presentation, deniedBy }) => {
      const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
      const service = support.createService(support.createProvider({ provision }));
      if (deniedBy === "live") {
        support.testState.config.tools = { deny: ["screen"] };
      }
      const respond = vi.fn();
      const context = createDirectChatContext({
        getRuntimeConfig: () => support.testState.config,
        workerEnvironmentService: service,
      });
      await withGatewayToolCallerIdentity(
        {
          ...identity,
          operationalRunInstance: { instanceId: "screen-instance", runId: "screen-run" },
          receiptAuthority: () => true,
          ...(deniedBy === "missing"
            ? {}
            : {
                assertToolAllowed: (tool: string) => {
                  expect(tool).toBe("screen");
                  if (deniedBy === "captured") {
                    throw new Error("Captured policy denies screen");
                  }
                },
              }),
        },
        async () => {
          await environmentsSessionHandlers["environments.session.create"]!({
            req: { type: "req", id: "create-preview", method: "environments.session.create" },
            params: {
              profileId: request.profileId,
              idempotencyKey: request.idempotencyKey,
              presentation,
            },
            context,
            client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
            isWebchatConnect: () => false,
            respond,
          });
        },
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringMatching(/screen|captured tool authority/u),
        }),
      );
      expect(support.testState.store.list()).toEqual([]);
      expect(provision).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("cancels its exact fresh reservation if screen policy narrows before presentation", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    const reserve = support.testState.store.createSessionAttachmentIntent.bind(
      support.testState.store,
    );
    const reserveSpy = vi
      .spyOn(support.testState.store, "createSessionAttachmentIntent")
      .mockImplementation((...args) => {
        const reserved = reserve(...args);
        support.testState.config.tools = { deny: ["screen"] };
        return reserved;
      });
    const respond = vi.fn();
    const context = createDirectChatContext({
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: service,
    });
    try {
      await withGatewayToolCallerIdentity(
        {
          ...identity,
          operationalRunInstance: { instanceId: "screen-instance", runId: "screen-run" },
          receiptAuthority: () => true,
          assertToolAllowed: () => {},
        },
        async () => {
          await environmentsSessionHandlers["environments.session.create"]!({
            req: { type: "req", id: "create-preview", method: "environments.session.create" },
            params: {
              profileId: request.profileId,
              idempotencyKey: request.idempotencyKey,
              presentation: "portal",
            },
            context,
            client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
            isWebchatConnect: () => false,
            respond,
          });
        },
      );
    } finally {
      reserveSpy.mockRestore();
    }
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Conversation policy denies screen" }),
    );
    const result = service.getSessionAttachmentStatus(identity.sessionId)!;
    expect(result.attachment.closedAtMs).not.toBeNull();
    expect(result.environment.state).toBe("failed");
    expect(provision).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("reuses concurrent and changed-key retries without moving the conversation or allowing placement adoption", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    const [first, retry] = await Promise.all([
      service.createSessionAttachment({ ...request, os: "linux", machineClass: "tiny" }, authorize),
      service.createSessionAttachment(
        { ...request, idempotencyKey: "retried-tool-call" },
        authorize,
      ),
    ]);
    expect(provision).toHaveBeenCalledOnce();
    expect(retry.attachment).toEqual(first.attachment);
    expect(retry.reused).toBe(true);
    expect(
      support.testState.store.get(first.attachment.environmentId)?.profileSnapshot,
    ).toMatchObject({ os: "linux", machineClass: "tiny" });
    const explicitRetry = await service.createSessionAttachment(
      { ...request, os: "linux", machineClass: "tiny" },
      authorize,
    );
    expect(explicitRetry.attachment.environmentId).toBe(first.attachment.environmentId);
    for (const incompatible of [{ os: "windows" }, { machineClass: "large" }]) {
      await expect(
        service.createSessionAttachment({ ...request, ...incompatible }, authorize),
      ).rejects.toThrow("already owns a different environment");
    }
    expect(provision).toHaveBeenCalledOnce();
    expect(first.environment).toMatchObject({ state: "ready", attachedSessionIds: [] });
    expect(service.findSessionAttachment(identity)).toMatchObject({
      ...identity,
      environmentId: first.attachment.environmentId,
    });
    await expect(service.attachSession(first.attachment)).rejects.toThrow("cannot be adopted");
  });

  it("cancels a queued allocation when Stop arrives before its attachment is reserved", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    const creation = service.createSessionAttachment(request, authorize);
    await service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize);
    await expect(creation).rejects.toThrow("was stopped");
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it.each([
    { phase: "installation", authority: "allowed" },
    { phase: "installation", authority: "run-revoked" },
    { phase: "installation", authority: "screen-revoked" },
    { phase: "provider", authority: "allowed" },
    { phase: "provider", authority: "run-revoked" },
    { phase: "provider", authority: "screen-revoked" },
  ] as const)(
    "checks $authority after deferred $phase preparation before allocation without an abort",
    async ({ phase, authority }) => {
      const entered = createDeferredCore();
      const released = createDeferredCore();
      const signalOwner = new AbortController();
      const allocate = vi.fn(async () => ({
        leaseId: "lease-authorized",
        ssh: support.SSH_ENDPOINT,
      }));
      if (phase === "installation") {
        support.testState.prepareInstallation = async () => {
          entered.resolve();
          await released.promise;
          return support.BUNDLE_ARTIFACT;
        };
      }
      const service = support.createService(
        support.createProvider({
          prepareProvision: async () => {
            if (phase === "provider") {
              entered.resolve();
              await released.promise;
            }
            return allocate;
          },
        }),
      );
      const requester: GatewayClient = {
        connId: "requesting-preview-ui",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_IDS.CONTROL_UI,
            version: "test",
            platform: "web",
            mode: "ui",
          },
          caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
        },
      };
      const context = createDirectChatContext({
        getRuntimeConfig: () => support.testState.config,
        workerEnvironmentService: service,
        getClientConnIds: (filter) =>
          new Set(!filter || filter(requester) ? [requester.connId!] : []),
      });
      const respond = vi.fn();
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "create-preview", method: "environments.session.create" },
        params: {
          profileId: request.profileId,
          idempotencyKey: request.idempotencyKey,
          presentation: "desktop",
        },
        client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
        context,
        isWebchatConnect: () => false,
        respond,
      };
      let runCurrent = true;
      await withGatewayToolCallerIdentity(
        {
          ...identity,
          operationalRunInstance: { instanceId: "allocation-instance", runId: "allocation-run" },
          receiptAuthority: () => runCurrent,
          assertToolAllowed: () => {},
          approvalSignals: [signalOwner.signal],
          gatewayUiCommandTarget: { connId: requester.connId! },
        },
        async () => {
          const foreignRespond = vi.fn();
          await environmentsSessionHandlers["environments.session.create"]!({
            ...options,
            params: { ...options.params, sessionKey: "agent:main:foreign" },
            respond: foreignRespond,
          });
          expect(foreignRespond.mock.calls[0]?.[0]).toBe(false);
          expect(support.testState.store.list()).toEqual([]);
          const creation = environmentsSessionHandlers["environments.session.create"]!(options);
          await Promise.race([
            entered.promise,
            Promise.resolve(creation).then(() => {
              throw new Error(
                `Creation ended before provider preparation: ${JSON.stringify(respond.mock.calls[0])}`,
              );
            }),
          ]);
          expect(allocate).not.toHaveBeenCalled();
          const reserved = service.getSessionAttachmentStatus(identity.sessionId)!;
          const queuedRecovery = service.reconcileOnce(reserved.attachment.environmentId);
          if (authority === "run-revoked") {
            runCurrent = false;
          }
          if (authority === "screen-revoked") {
            support.testState.config.tools = { deny: ["screen"] };
          }
          released.resolve();
          await Promise.all([creation, queuedRecovery]);
        },
      );
      expect(signalOwner.signal.aborted).toBe(false);
      expect(respond.mock.calls[0]?.[0]).toBe(authority === "allowed");
      expect(allocate).toHaveBeenCalledTimes(authority === "allowed" ? 1 : 0);
      const result = service.getSessionAttachmentStatus(identity.sessionId)!;
      if (authority !== "allowed") {
        expect(result.attachment.closedAtMs).not.toBeNull();
        expect(result.environment.state).toBe("failed");
      }
      await service.reconcileOnce(result.attachment.environmentId);
      expect(allocate).toHaveBeenCalledTimes(authority === "allowed" ? 1 : 0);
    },
  );

  it("presents the actual reserved machine before allocation and keeps recovery behind required presentation", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    const reserved = createDeferredCore<string>();
    const presented = createDeferredCore();
    const onReserved = vi.fn(
      async ({ environmentId, reused }: { environmentId: string; reused: boolean }) => {
        expect(reused).toBe(false);
        expect(service.get(environmentId)?.state).toBe("requested");
        expect(
          service.getSessionAttachmentStatus(identity.sessionId)?.attachment.environmentId,
        ).toBe(environmentId);
        reserved.resolve(environmentId);
        await presented.promise;
      },
    );
    const creation = service.createSessionAttachment(request, authorize, undefined, onReserved);
    const environmentId = await reserved.promise;
    const recovery = service.reconcileOnce(environmentId);
    await Promise.resolve();
    expect(provision).not.toHaveBeenCalled();
    presented.resolve();
    const [created] = await Promise.all([creation, recovery]);
    expect(created.attachment.environmentId).toBe(environmentId);
    expect(provision).toHaveBeenCalledOnce();
    const showExisting = vi.fn(async () => {});
    await service.createSessionAttachment(
      { ...request, idempotencyKey: "show-again" },
      authorize,
      undefined,
      showExisting,
    );
    expect(showExisting).toHaveBeenCalledWith({ environmentId, reused: true });
    expect(provision).toHaveBeenCalledOnce();
  });

  it.each(["presentation rejected", "requester revoked"] as const)(
    "cancels the durable allocation intent when required presentation fails: %s",
    async (failure) => {
      const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
      const service = support.createService(support.createProvider({ provision }));
      let live = true;
      const assertCurrent = () => {
        if (!live) {
          throw new Error("requester revoked");
        }
      };
      await expect(
        service.createSessionAttachment(request, assertCurrent, undefined, async () => {
          if (failure === "presentation rejected") {
            throw new Error(failure);
          }
          live = false;
        }),
      ).rejects.toThrow(failure);
      const result = service.getSessionAttachmentStatus(identity.sessionId)!;
      expect(result.attachment.closedAtMs).not.toBeNull();
      expect(result.environment.state).toBe("failed");
      await service.reconcileOnce(result.attachment.environmentId);
      expect(provision).not.toHaveBeenCalled();
    },
  );

  it("preserves the attachment through reopen and rejects the old session incarnation after replacement", async () => {
    const provider = support.createProvider();
    let service = support.createService(provider);
    const created = await service.createSessionAttachment(request, authorize);
    await support.reopenWorkerEnvironmentStore();
    service = support.createService(provider);
    expect(service.findSessionAttachment(identity)).toMatchObject({
      ...identity,
      environmentId: created.attachment.environmentId,
    });
    replaceSessionEntrySync(scope(), {
      sessionId: identity.sessionId,
      lifecycleRevision: "reset-incarnation",
      updatedAt: 2,
    });
    expect(service.findSessionAttachment(identity)).toBeUndefined();
    expect(() => service.assertSessionAttachment(created.attachment)).toThrow("no longer current");
    await service.reconcileSessionAttachments();
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
  });

  it("closes authorization before waiting for provider teardown and requires a fresh key for a replacement", async () => {
    const stopped = createDeferredCore();
    const destroy = vi.fn(async () => await stopped.promise);
    let allocations = 0;
    const service = support.createService(
      support.createProvider({
        destroy,
        provision: async () => ({ leaseId: `lease-${++allocations}`, ssh: support.SSH_ENDPOINT }),
      }),
    );
    const created = await service.createSessionAttachment(request, authorize);
    const teardown = service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize);
    expect(service.findSessionAttachment(identity)).toBeUndefined();
    expect(() => service.assertSessionAttachment(created.attachment)).toThrow("no longer current");
    stopped.resolve();
    await teardown;
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
    await expect(service.createSessionAttachment(request, authorize)).rejects.toThrow(
      "already stopped",
    );
    const next = await service.createSessionAttachment(
      { ...request, idempotencyKey: "new-box" },
      authorize,
    );
    expect(next.attachment.generation).toBe(created.attachment.generation + 1);
  });

  it("retains a failed cleanup owner and forbids replacement until provider destruction is confirmed", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const service = support.createService(support.createProvider({ destroy }));
    const created = await service.createSessionAttachment(request, authorize);
    await expect(
      service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize),
    ).rejects.toThrow("provider unavailable");
    await expect(
      service.createSessionAttachment({ ...request, idempotencyKey: "replacement" }, authorize),
    ).rejects.toThrow("already owns");
    expect(
      service.getSessionAttachmentStatus(identity.sessionId)?.attachment.closedAtMs,
    ).not.toBeNull();
    await service.reconcileSessionAttachments();
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("does not allocate after caller revocation and expires only the unchanged idle attachment", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    await expect(
      service.createSessionAttachment(request, () => {
        throw new Error("run ended");
      }),
    ).rejects.toThrow("run ended");
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
    support.getDevelopmentProfile().suspendAfter = "1m";
    const created = await service.createSessionAttachment(request, authorize);
    support.testState.nowMs += 59_000;
    service.touchSessionAttachment(created.attachment);
    support.testState.nowMs += 59_000;
    await service.reconcileSessionAttachments();
    expect(service.findSessionAttachment(identity)).toBeDefined();
    support.testState.nowMs += 1_001;
    await service.reconcileSessionAttachments();
    expect(service.findSessionAttachment(identity)).toBeUndefined();
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
  });
});

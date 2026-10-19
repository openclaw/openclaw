import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  environmentsSessionHandlers,
  resolveSessionEnvironmentCaller,
} from "../server-methods/environments.session.js";
import { portalHandlers } from "../server-methods/portals.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { makeGatewayClient } from "../server-request-context.test-support.js";
import * as support from "./service.test-support.js";

support.setupWorkerEnvironmentServiceSuite();
const state = support.testState;
const identity = {
  sessionId: "conversation-one",
  sessionKey: "agent:main:crabbox",
  agentId: "main",
};
const request = { ...identity, profileId: "development", idempotencyKey: "open-desktop" };
const authorize = () => {};
type Service = ReturnType<typeof support.createService>;
let service: Service;
let provision = vi.fn(async () => ({ leaseId: "lease-1", ssh: support.SSH_ENDPOINT }));
const makeService = (
  overrides: Parameters<typeof support.createProvider>[0] = {},
  options: Parameters<typeof support.createService>[1] = {},
) => {
  service = support.createService(support.createProvider({ provision, ...overrides }), options);
};
const create = (
  overrides: Partial<Parameters<Service["createSessionAttachment"]>[0]> = {},
  onReserved?: Parameters<Service["createSessionAttachment"]>[3],
) =>
  service.createSessionAttachment({ ...request, ...overrides }, authorize, undefined, onReserved);
const stop = () => service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize);
const dedicated = { dedicatedOnly: true };
const createDedicated = (assertCurrent = authorize) =>
  service.createSessionAttachment(request, assertCurrent, undefined, undefined, dedicated);
const stopDedicated = () =>
  service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize, dedicated);
function barrier() {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  return {
    entered: entered.promise,
    release: released.resolve,
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}
const outcome = <T>(operation: Promise<T>) =>
  operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const awaitBlocked = (entered: Promise<void>, operation: Promise<unknown>, message: string) =>
  Promise.race([
    entered,
    operation.then((cause) => {
      throw new Error(message, { cause });
    }),
  ]);
const runAsCaller = <T>(
  run: () => Promise<T> | T,
  overrides: Partial<NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>> = {},
) =>
  withGatewayToolCallerIdentity(
    {
      ...identity,
      operationalRunInstance: { instanceId: "run-instance", runId: "run-one" },
      receiptAuthority: () => true,
      ...overrides,
    },
    run,
  );
const scope = () => ({
  agentId: identity.agentId,
  sessionKey: identity.sessionKey,
  storePath: state.config.session!.store,
});
const replaceSession = () =>
  replaceSessionEntrySync(scope(), {
    sessionId: identity.sessionId,
    lifecycleRevision: "reset-incarnation",
    updatedAt: 2,
  });
function createRpc(
  params: Record<string, unknown> = {},
  overrides: Parameters<typeof createDirectChatContext>[0] = {},
  method = "environments.session.create",
  existingContext?: GatewayRequestHandlerOptions["context"],
) {
  const respond = vi.fn();
  const context =
    existingContext ??
    createDirectChatContext({
      getRuntimeConfig: () => state.config,
      workerEnvironmentService: service,
      ...overrides,
    });
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "attachment-rpc", method },
    params:
      method === "environments.session.create"
        ? { profileId: request.profileId, idempotencyKey: request.idempotencyKey, ...params }
        : params,
    context,
    client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
    isWebchatConnect: () => false,
    respond,
  };
  const handlers = method === "portal.open" ? portalHandlers : environmentsSessionHandlers;
  return { options, respond, context, invoke: () => handlers[method]!(options) };
}
function expectReply(
  respond: ReturnType<typeof createRpc>["respond"],
  payload: Record<string, unknown>,
  ok = true,
) {
  expect(respond.mock.calls[0]).toHaveLength(ok ? 2 : 3);
  expect(respond.mock.calls[0]).toMatchObject(ok ? [true, payload] : [false, undefined, payload]);
}

beforeEach(() => {
  provision = vi.fn(async () => ({ leaseId: "lease-1", ssh: support.SSH_ENDPOINT }));
  state.config.session = { store: path.join(state.root, "sessions.json") };
  ensureSessionEntrySync(scope(), { sessionId: identity.sessionId, updatedAt: 1 });
  makeService();
});
afterEach(() => closeOpenClawAgentDatabases());

it.each([
  undefined,
  () => false,
  () => "true",
  () => {
    throw new Error("provider retired");
  },
])(
  "requires an explicit delegated-access opt-in before reservation or spending (%#)",
  async (supportsDelegatedSessionAccess) => {
    const resolveAllocation = vi.fn(async () => ({ leaseId: "lease-1", sharedHost: false }));
    makeService({
      supportsDelegatedSessionAccess: supportsDelegatedSessionAccess as never,
      resolveAllocation,
    });
    await expect(createDedicated()).rejects.toThrow();
    expect(resolveAllocation).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(state.store.list()).toEqual([]);
    expect(service.getSessionAttachmentStatus(identity.sessionId)).toBeUndefined();
  },
);

it("rechecks delegated eligibility after deferred reservation and cleans up after revocation", async () => {
  let eligible = true;
  const supportsDelegatedSessionAccess = vi.fn(() => eligible);
  makeService({ supportsDelegatedSessionAccess });
  await expect(
    service.createSessionAttachment(
      request,
      authorize,
      undefined,
      async () => {
        eligible = false;
      },
      dedicated,
    ),
  ).rejects.toThrow("requires administrator access");
  expect(provision).not.toHaveBeenCalled();
  expect(service.getSessionAttachment(identity.sessionId)).toBeUndefined();
  expect(state.store.list().every((record) => record.state === "failed")).toBe(true);
});

it("rejects retired delegated eligibility after provider preparation without allocating", async () => {
  const gate = barrier();
  let eligible = true;
  const allocate = vi.fn(async () => ({ leaseId: "lease-1", ssh: support.SSH_ENDPOINT }));
  makeService({
    supportsDelegatedSessionAccess: () => eligible,
    prepareProvision: async () => {
      await gate.wait();
      return allocate;
    },
  });
  const creation = outcome(createDedicated());
  await awaitBlocked(gate.entered, creation, "Creation ended before preparation");
  eligible = false;
  gate.release();
  expect(await creation).toMatchObject({
    error: { message: "This cloud worker profile requires administrator access" },
  });
  expect(allocate).not.toHaveBeenCalled();
  expect(service.getSessionAttachment(identity.sessionId)).toBeUndefined();
});

it("does not let a limited create clean up an old incarnation's unqualified attachment", async () => {
  const destroy = vi.fn(async () => {});
  makeService({ destroy });
  const { attachment } = await create();
  replaceSession();
  await expect(createDedicated()).rejects.toThrow("administrator must clean up");
  expect(destroy).not.toHaveBeenCalled();
  expect(service.getSessionAttachmentStatus(identity.sessionId)?.attachment).toMatchObject({
    environmentId: attachment.environmentId,
    closedAtMs: null,
  });
});

it("creates and stops a dedicated node attachment while preserving teardown after its own revocation", async () => {
  const destroy = vi.fn(async () => {});
  makeService(
    {
      supportsDelegatedSessionAccess: () => true,
      provision: async () => ({
        leaseId: "lease-1",
        node: { deviceId: "node-one" },
        sharedHost: false,
      }),
      inspect: async () => ({ status: "active", sharedHost: false }),
      destroy,
    },
    { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
  );
  const { attachment } = await createDedicated();
  const signal = service.getDedicatedNodeLeaseSignal(attachment.environmentId)!;
  expect(signal.aborted).toBe(false);
  expect((await createDedicated()).reused).toBe(true);
  await expect(stopDedicated()).resolves.toMatchObject({ state: "destroyed" });
  expect(signal.aborted).toBe(true);
  expect(destroy).toHaveBeenCalledOnce();
});

it("refuses active unattested attachments but lets an administrator stop them", async () => {
  makeService({ supportsDelegatedSessionAccess: () => true });
  const { attachment } = await create();
  await expect(stopDedicated()).rejects.toThrow("current dedicated cloud worker");
  expect(service.getSessionAttachment(identity.sessionId)).toMatchObject(attachment);
  await expect(stop()).resolves.toMatchObject({ state: "destroyed" });
});

it("keeps admin-created workers private until their frozen target permits delegated access", async () => {
  let eligible = false;
  const supportsDelegatedSessionAccess = vi.fn(() => eligible);
  makeService(
    {
      supportsDelegatedSessionAccess,
      provision: async () => ({
        leaseId: "lease-1",
        node: { deviceId: "node-one" },
        sharedHost: false,
      }),
      inspect: async () => ({ status: "active", sharedHost: false }),
    },
    { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
  );
  const { attachment } = await create();
  const stored = state.store.get(attachment.environmentId)!;
  state.config.cloudWorkers!.profiles!.development!.settings = { backend: "later-config" };
  await expect(createDedicated()).rejects.toThrow("requires administrator access");
  await expect(stopDedicated()).rejects.toThrow("requires administrator access");
  expect(() => service.assertSessionAttachment(attachment, dedicated)).toThrow(
    "requires administrator access",
  );
  expect(service.getSessionAttachment(identity.sessionId)).toMatchObject(attachment);
  eligible = true;
  expect(() => service.assertSessionAttachment(attachment, dedicated)).not.toThrow();
  expect(supportsDelegatedSessionAccess).toHaveBeenLastCalledWith(
    stored.profileSnapshot.settings,
    stored.profileSnapshot.machineClass,
    stored.profileSnapshot.os,
  );
  eligible = false;
  await expect(stop()).resolves.toMatchObject({ state: "destroyed" });
});

it("does not close an attachment that appears after an empty cleanup admission", async () => {
  const ready = state.store.ready.bind(state.store);
  vi.spyOn(state.store, "ready")
    .mockImplementationOnce(ready)
    .mockImplementationOnce(async () => {
      await ready();
      await state.store.createSessionAttachmentIntent(
        {
          ...identity,
          environmentId: "later-environment",
          providerId: "fake",
          profileId: "development",
          profileSnapshot: { settings: {} },
          provisionOperationId: "later-allocation",
        },
        authorize,
      );
    });
  await expect(stopDedicated()).rejects.toThrow("changed before cleanup");
  expect(state.store.getSessionAttachmentRecord(identity.sessionId)).toMatchObject({
    environmentId: "later-environment",
    closedAtMs: null,
  });
});

it("cleans the stored lease after failed provisioning without rediscovering allocation", async () => {
  let eligible = true;
  const resolveAllocation = vi.fn(async () => ({ leaseId: "different-lease", sharedHost: false }));
  const destroy = vi.fn().mockRejectedValue(new Error("cleanup temporarily unavailable"));
  makeService(
    {
      supportsDelegatedSessionAccess: () => eligible,
      resolveAllocation,
      provision: async () => ({
        leaseId: "lease-1",
        node: { deviceId: "node-one" },
        sharedHost: false,
      }),
      destroy,
    },
    {
      ensureNodeWorkerBundle: async () => {
        throw new Error("bootstrap failed");
      },
    },
  );
  await expect(createDedicated()).rejects.toThrow("bootstrap failed");
  const status = service.getSessionAttachmentStatus(identity.sessionId)!;
  expect(status.attachment.closedAtMs).not.toBeNull();
  expect(service.getDedicatedNodeLeaseSignal(status.environment.environmentId)).toBeUndefined();
  destroy.mockResolvedValue(undefined);
  eligible = false;
  await expect(stopDedicated()).rejects.toThrow("requires administrator access");
  eligible = true;
  await expect(stopDedicated()).resolves.toMatchObject({ state: "failed", leaseId: null });
  expect(resolveAllocation).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenLastCalledWith(
    expect.objectContaining({
      leaseId: "lease-1",
      profile: state.store.get(status.environment.environmentId)!.profileSnapshot.settings,
    }),
  );
});

it.each([true, undefined])(
  "closes a new attachment when provision contradicts dedication (%s)",
  async (sharedHost) => {
    const destroy = vi.fn(async () => {});
    const provision = vi.fn(async () => ({
      leaseId: "lease-1",
      node: { deviceId: "node-one" },
      sharedHost,
    }));
    makeService(
      {
        supportsDelegatedSessionAccess: () => true,
        provision,
        destroy,
        inspect: async () => ({ status: "active", sharedHost }),
      },
      {
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      },
    );
    await expect(createDedicated()).rejects.toThrow();
    expect(provision).toHaveBeenCalledOnce();
    expect(service.getSessionAttachment(identity.sessionId)).toBeUndefined();
    expect(service.getSessionAttachmentStatus(identity.sessionId)?.attachment.closedAtMs).toEqual(
      expect.any(Number),
    );
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ leaseId: "lease-1" }));
  },
);

it("stops an admitted dedicated allocation while provision is pending", async () => {
  let eligible = true;
  const gate = barrier();
  const destroy = vi.fn(async () => {});
  const resolveAllocation = vi.fn(async () => ({ leaseId: "lease-1", sharedHost: false }));
  makeService(
    {
      supportsDelegatedSessionAccess: () => eligible,
      resolveAllocation,
      provision: async () => {
        await gate.wait();
        return { leaseId: "lease-1", node: { deviceId: "node-one" }, sharedHost: false };
      },
      destroy,
    },
    { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
  );
  const creation = outcome(createDedicated());
  await awaitBlocked(gate.entered, creation, "Creation ended before provision");
  eligible = false;
  await expect(stopDedicated()).rejects.toThrow("requires administrator access");
  expect(service.getSessionAttachmentStatus(identity.sessionId)?.attachment.closedAtMs).toBeNull();
  eligible = true;
  const closing = outcome(stopDedicated());
  try {
    await support.waitForFast(() => {
      expect(service.getSessionAttachmentStatus(identity.sessionId)?.attachment.closedAtMs).toEqual(
        expect.any(Number),
      );
    });
    expect(resolveAllocation).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  } finally {
    gate.release();
  }
  expect(await creation).toHaveProperty("error");
  expect(await closing).toMatchObject({ value: { state: "destroyed" } });
  expect(destroy).toHaveBeenCalled();
});

it("admits the actual plugin RPC through ambient run authority and fences a retained caller after revocation", async () => {
  const { options, respond, invoke } = createRpc();
  await expect(resolveSessionEnvironmentCaller(options)).rejects.toThrow(
    "authenticated operator or admitted agent run",
  );
  let live = true;
  await runAsCaller(
    async () => {
      const caller = await resolveSessionEnvironmentCaller(options);
      await expect(
        resolveSessionEnvironmentCaller(options, { sessionKey: "agent:main:other" }),
      ).rejects.toThrow("only manage its own");
      await invoke();
      expectReply(respond, { environment: { status: "available" } });
      live = false;
      expect(caller.assertCurrent).toThrow("no longer active");
      caller.release();
    },
    { receiptAuthority: () => live },
  );
});

it("opens a portal through ambient plugin authority and closes an unused carrier when that authority ends", async () => {
  const { attachment } = await create();
  const { environmentId, ownerEpoch } = attachment;
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
  const { context } = createRpc({}, { portalService, broadcast: vi.fn() });
  const open = async (target: string, port: number) => {
    const rpc = createRpc({ environmentId: target, port }, {}, "portal.open", context);
    await rpc.invoke();
    return rpc.respond.mock.calls[0]?.[0];
  };
  try {
    await runAsCaller(
      async () => {
        expect(await open(environmentId, 3000)).toBe(true);
        expect(portalService.listWorkerPortals(environmentId, ownerEpoch)).toHaveLength(1);
        expect(await open("worker:another-conversation", 3000)).toBe(false);
        expect(openNodePortal).toHaveBeenCalledTimes(1);
        revokeDuringDiscovery = true;
        expect(await open(environmentId, 3001)).toBe(false);
        expect(closeConnection).toHaveBeenCalledOnce();
        expect(portalService.list()).toHaveLength(1);
      },
      { receiptAuthority: () => live, gatewayContextResolver: () => context },
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
    if (deniedBy === "live") {
      state.config.tools = { deny: ["screen"] };
    }
    const { respond, context, invoke } = createRpc({ presentation });
    await runAsCaller(
      invoke,
      deniedBy === "missing"
        ? {}
        : {
            assertToolAllowed: (tool: string) => {
              expect(tool).toBe("screen");
              if (deniedBy === "captured") {
                throw new Error("Captured policy denies screen");
              }
            },
          },
    );
    expectReply(
      respond,
      { message: expect.stringMatching(/screen|captured tool authority/u) },
      false,
    );
    expect(state.store.list()).toEqual([]);
    expect(provision).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  },
);

it("cancels its exact fresh reservation if screen policy narrows before presentation", async () => {
  const reserve = state.store.createSessionAttachmentIntent.bind(state.store);
  const reserveSpy = vi
    .spyOn(state.store, "createSessionAttachmentIntent")
    .mockImplementation(async (...args) => {
      const reserved = await reserve(...args);
      state.config.tools = { deny: ["screen"] };
      return reserved;
    });
  const { respond, context, invoke } = createRpc({ presentation: "portal" });
  try {
    await runAsCaller(invoke, { assertToolAllowed: () => {} });
  } finally {
    reserveSpy.mockRestore();
  }
  expectReply(respond, { message: "Conversation policy denies screen" }, false);
  const result = service.getSessionAttachmentStatus(identity.sessionId)!;
  expect(result.attachment.closedAtMs).not.toBeNull();
  expect(result.environment.state).toBe("failed");
  expect(provision).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

it("reuses concurrent and changed-key retries without moving the conversation or allowing placement adoption", async () => {
  const [first, retry] = await Promise.all([
    create({ os: "linux", machineClass: "tiny" }),
    create({ idempotencyKey: "retried-tool-call" }),
  ]);
  expect(provision).toHaveBeenCalledOnce();
  expect(retry.attachment).toEqual(first.attachment);
  expect(retry.reused).toBe(true);
  const snapshot = state.store.get(first.attachment.environmentId)?.profileSnapshot;
  expect(snapshot).toMatchObject({ os: "linux", machineClass: "tiny" });
  const explicitRetry = await create({ os: "linux", machineClass: "tiny" });
  expect(explicitRetry.attachment.environmentId).toBe(first.attachment.environmentId);
  for (const incompatible of [{ os: "windows" }, { machineClass: "large" }]) {
    await expect(create(incompatible)).rejects.toThrow("already owns a different environment");
  }
  expect(provision).toHaveBeenCalledOnce();
  expect(first.environment).toMatchObject({ state: "ready", attachedSessionIds: [] });
  expect(service.findSessionAttachment(identity)).toMatchObject({
    ...identity,
    environmentId: first.attachment.environmentId,
  });
  await expect(service.attachSession(first.attachment)).rejects.toThrow("cannot be adopted");
});

it("cancels creations registered while Stop is awaiting the inventory", async () => {
  const closingGate = barrier();
  const creationGate = barrier();
  const ready = state.store.ready.bind(state.store);
  vi.spyOn(state.store, "ready")
    .mockImplementationOnce(async () => {
      await ready();
      await closingGate.wait();
    })
    .mockImplementationOnce(async () => {
      await ready();
      await creationGate.wait();
    });
  const closing = outcome(stop());
  let creation: Promise<unknown> | undefined;
  try {
    await awaitBlocked(closingGate.entered, closing, "Stop ended before inventory readiness");
    creation = outcome(create());
    await awaitBlocked(creationGate.entered, creation, "Creation ended before inventory readiness");
    closingGate.release();
    expect(await closing).toEqual({ value: undefined });
    creationGate.release();
    expect(await creation).toMatchObject({
      error: { message: "Conversation environment was stopped" },
    });
    expect(provision).not.toHaveBeenCalled();
    expect(state.store.list()).toEqual([]);
  } finally {
    closingGate.release();
    creationGate.release();
    await Promise.all([closing, creation]);
  }
});

it.each([
  { phase: "installation", authority: "allowed" },
  { phase: "installation", authority: "run-revoked" },
  { phase: "provider", authority: "screen-revoked" },
] as const)(
  "checks $authority after deferred $phase preparation before allocation without an abort",
  async ({ phase, authority }) => {
    const preparation = barrier();
    const signalOwner = new AbortController();
    const allocate = vi.fn(async () => ({
      leaseId: "lease-authorized",
      ssh: support.SSH_ENDPOINT,
    }));
    if (phase === "installation") {
      state.prepareInstallation = async () => {
        await preparation.wait();
        return support.BUNDLE_ARTIFACT;
      };
    }
    makeService({
      prepareProvision: async () => {
        if (phase === "provider") {
          await preparation.wait();
        }
        return allocate;
      },
    });
    const requester = makeGatewayClient({
      connId: "requesting-preview-ui",
      clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: "ui",
      caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
    });
    const { respond, invoke } = createRpc(
      { presentation: "desktop" },
      {
        getClientConnIds: (filter) =>
          new Set(!filter || filter(requester) ? [requester.connId!] : []),
      },
    );
    let runCurrent = true;
    await runAsCaller(
      async () => {
        const creation = invoke();
        await awaitBlocked(
          preparation.entered,
          Promise.resolve(creation),
          "Creation ended before provider preparation",
        );
        expect(allocate).not.toHaveBeenCalled();
        const reserved = service.getSessionAttachmentStatus(identity.sessionId)!;
        const queuedRecovery = service.reconcileOnce(reserved.attachment.environmentId);
        if (authority === "run-revoked") {
          runCurrent = false;
        }
        if (authority === "screen-revoked") {
          state.config.tools = { deny: ["screen"] };
        }
        preparation.release();
        await Promise.all([creation, queuedRecovery]);
      },
      {
        receiptAuthority: () => runCurrent,
        assertToolAllowed: () => {},
        approvalSignals: [signalOwner.signal],
        gatewayUiCommandTarget: { connId: requester.connId! },
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
  const reserved = createDeferredCore<string>();
  const presented = createDeferredCore();
  const onReserved = vi.fn(
    async ({ environmentId, reused }: { environmentId: string; reused: boolean }) => {
      expect(reused).toBe(false);
      expect(service.get(environmentId)?.state).toBe("requested");
      expect(service.getSessionAttachmentStatus(identity.sessionId)?.attachment.environmentId).toBe(
        environmentId,
      );
      reserved.resolve(environmentId);
      await presented.promise;
    },
  );
  const creation = create({}, onReserved);
  const environmentId = await reserved.promise;
  const recovery = service.reconcileOnce(environmentId);
  await Promise.resolve();
  expect(provision).not.toHaveBeenCalled();
  presented.resolve();
  const [{ attachment }] = await Promise.all([creation, recovery]);
  expect(attachment.environmentId).toBe(environmentId);
  expect(provision).toHaveBeenCalledOnce();
  const showExisting = vi.fn(async () => {});
  await create({ idempotencyKey: "show-again" }, showExisting);
  expect(showExisting).toHaveBeenCalledWith({ environmentId, reused: true });
  expect(provision).toHaveBeenCalledOnce();
});

it("preserves the attachment through reopen and rejects the old session incarnation after replacement", async () => {
  const provider = support.createProvider();
  service = support.createService(provider);
  const { attachment } = await create();
  await support.reopenWorkerEnvironmentStore();
  service = support.createService(provider);
  await service.reconcileSessionAttachments();
  expect(service.findSessionAttachment(identity)).toMatchObject({
    ...identity,
    environmentId: attachment.environmentId,
  });
  replaceSession();
  expect(service.findSessionAttachment(identity)).toBeUndefined();
  expect(() => service.assertSessionAttachment(attachment)).toThrow("no longer current");
  await service.reconcileSessionAttachments();
  expect(service.get(attachment.environmentId)?.state).toBe("destroyed");
});

it("retires prepared attachment authority before reset cleanup awaits inventory readiness", async () => {
  const { attachment } = await create();
  const captured = service.captureSessionAttachment(attachment);
  service.start();
  await service.reconcileOnce();
  const resetGate = barrier();
  const ready = state.store.ready.bind(state.store);
  vi.spyOn(state.store, "ready").mockImplementationOnce(async () => {
    await resetGate.wait();
    await ready();
  });
  try {
    replaceSession();
    await resetGate.entered;
    expect(() => captured.assertCurrent()).toThrow("no longer current");
    expect(() => service.captureSessionAttachment(attachment)).toThrow();
  } finally {
    resetGate.release();
    await service.stop();
  }
});

it("closes authorization before waiting for provider teardown and requires a fresh key for a replacement", async () => {
  const stopped = createDeferredCore();
  const destroy = vi.fn(async () => await stopped.promise);
  let allocations = 0;
  makeService({
    destroy,
    provision: async () => ({ leaseId: `lease-${++allocations}`, ssh: support.SSH_ENDPOINT }),
  });
  const { attachment } = await create();
  const teardown = stop();
  expect(service.findSessionAttachment(identity)).toBeUndefined();
  expect(() => service.assertSessionAttachment(attachment)).toThrow("no longer current");
  stopped.resolve();
  await teardown;
  expect(service.get(attachment.environmentId)?.state).toBe("destroyed");
  await expect(create()).rejects.toThrow("already stopped");
  const next = await create({ idempotencyKey: "new-box" });
  expect(next.attachment.generation).toBe(attachment.generation + 1);
});

it("reports bounded current cleanup failures without losing the original failure or lease", async () => {
  const originalFailure = "worker bootstrap could not finish";
  const firstCleanupFailure = "initial provider cleanup is unavailable";
  vi.mocked(state.bootstrapWorker).mockRejectedValue(new Error(originalFailure));
  const destroy = vi.fn().mockRejectedValue(new Error(firstCleanupFailure));
  const warn = vi.fn<(message: string) => void>();
  makeService({ destroy }, { logger: { warn } });

  await expect(create()).rejects.toThrow(originalFailure);
  await expect(stop()).rejects.toThrow(firstCleanupFailure);
  const environmentId = service.getSessionAttachmentStatus(identity.sessionId)!.environment
    .environmentId;
  const pending = state.store.get(environmentId)!;
  expect(pending).toMatchObject({
    state: "destroying",
    leaseId: "lease-1",
    teardownTerminalState: "failed",
    lastError: originalFailure,
  });
  expect(warn).not.toHaveBeenCalled();
  const secret = `synthetic-cleanup-auth-${"x".repeat(48)}`;
  const currentDiagnosis = "provider stop timed out while confirming release";
  destroy.mockRejectedValue(
    new Error(
      `Current cleanup failed: Authorization: Bearer ${secret}\n${"provider progress ".repeat(200)}\n${currentDiagnosis}`,
    ),
  );
  state.nowMs += 30_000;
  await service.reconcileSessionAttachments();

  expect(warn).toHaveBeenCalledOnce();
  const warning = warn.mock.calls[0]![0];
  const prefix = `Conversation environment cleanup will retry (${environmentId}): `;
  expect.soft(warning).toContain(prefix);
  expect.soft(warning).toContain("Current cleanup failed:");
  expect.soft(warning).toContain(currentDiagnosis);
  expect(warning).not.toContain(secret);
  expect(warning).not.toContain(originalFailure);
  expect(warning.length).toBeLessThanOrEqual(prefix.length + 1_024);
  expect(state.store.get(environmentId)).toMatchObject({
    state: "destroying",
    leaseId: pending.leaseId,
    lastError: originalFailure,
  });

  destroy.mockResolvedValue(undefined);
  state.nowMs += 60_000;
  await service.reconcileSessionAttachments();
  expect(state.store.get(environmentId)).toMatchObject({
    state: "failed",
    leaseId: null,
    lastError: originalFailure,
  });
  expect(warn).toHaveBeenCalledOnce();
});

it("bounds conversation cleanup attempts across four hours of transient provider failure", async () => {
  const destroy = vi.fn().mockRejectedValue(new Error("coordinator release: http 503"));
  const warn = vi.fn<(message: string) => void>();
  makeService({ id: "crabbox", destroy }, { logger: { warn } });
  support.getDevelopmentProfile().provider = "crabbox";
  const { attachment } = await create();
  await expect(stop()).rejects.toThrow("http 503");
  for (let sweep = 0; sweep < 95; sweep += 1) {
    state.nowMs += 150_000;
    await service.reconcileOnce();
    await service.reconcileEnvironment(attachment.environmentId);
  }
  expect(destroy).toHaveBeenCalledTimes(10);
  expect(warn).toHaveBeenCalledTimes(9);
  const parked = warn.mock.calls.filter(([message]) => message.includes("cleanup parked"));
  expect(parked).toHaveLength(1);
  expect(parked[0]![0]).toContain("lease-1");
  expect(parked[0]![0]).toContain("http 503");
  expect(parked[0]![0]).toContain("crabbox stop lease-1");
  expect(parked[0]![0]).toContain("crabbox inspect --id lease-1 --json");
  expect(service.get(attachment.environmentId)?.error).toBe(parked[0]![0]);
  await runAsCaller(async () => {
    const { respond, invoke } = createRpc({}, {}, "environments.session.status");
    await invoke();
    expectReply(respond, {
      closed: true,
      environment: { status: "error", worker: { state: "destroying", error: parked[0]![0] } },
    });
  });
});

it("parks after one hour and resumes only on explicit stop", async () => {
  const destroy = vi.fn().mockRejectedValue(new Error("stop outcome unknown: http 404"));
  const warn = vi.fn<(message: string) => void>();
  makeService({ destroy }, { logger: { warn } });
  const { attachment } = await create();
  await expect(stop()).rejects.toThrow("http 404");
  state.nowMs += 3_600_000;
  await service.reconcileOnce();
  await service.reconcileOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
  expect(service.get(attachment.environmentId)?.error).toContain("parked");
  destroy.mockResolvedValue(undefined);
  await stop();
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(service.get(attachment.environmentId)).toMatchObject({ state: "destroyed" });
  expect(service.get(attachment.environmentId)?.error).toBeUndefined();
});

it("keeps an unconfirmed orphaned lease parked across status reads and sweeps", async () => {
  const warn = vi.fn<(message: string) => void>();
  makeService({}, { logger: { warn } });
  const { attachment } = await create();
  const environmentId = attachment.environmentId;
  await state.store.transition({ environmentId, from: "ready", to: "orphaned" });
  await expect(stop()).rejects.toThrow("cleanup is not confirmed (orphaned)");
  state.nowMs += 3_600_000;
  for (let sweep = 0; sweep < 3; sweep += 1) {
    await service.reconcileSessionAttachments();
    expect(service.get(environmentId)).toMatchObject({
      state: "orphaned",
      leaseId: "lease-1",
      error: expect.stringContaining("cleanup parked"),
    });
  }
  expect(warn).toHaveBeenCalledOnce();
});

it("does not allocate after caller revocation and expires only the unchanged idle attachment", async () => {
  await expect(
    service.createSessionAttachment(request, () => {
      throw new Error("run ended");
    }),
  ).rejects.toThrow("run ended");
  expect(provision).not.toHaveBeenCalled();
  expect(state.store.list()).toEqual([]);
  support.getDevelopmentProfile().suspendAfter = "1m";
  const { attachment } = await create();
  state.nowMs += 59_000;
  await service.touchSessionAttachment(attachment);
  state.nowMs += 59_000;
  await service.reconcileSessionAttachments();
  expect(service.findSessionAttachment(identity)).toBeDefined();
  state.nowMs += 1_001;
  await service.reconcileSessionAttachments();
  expect(service.findSessionAttachment(identity)).toBeUndefined();
  expect(service.get(attachment.environmentId)?.state).toBe("destroyed");
});

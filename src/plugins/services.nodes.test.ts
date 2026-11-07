import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { dispatchGatewayRequestInProcess } from "../gateway/server-in-process-dispatch.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import * as nativeModuleRequire from "./native-module-require.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  adoptPluginRegistryRecords,
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  bindGatewayContextResolver,
  getGatewayContextLifetime,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginServiceNodeInvoker } from "./service-nodes.js";
import { startPluginServices, type PluginServicesHandle } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const handles = new Set<PluginServicesHandle>();
afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
});

async function startFixture(
  options: { stop?: () => Promise<void>; gateway?: "bound" | "unbound" | "absent" } = {},
) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "files" });
  registry.plugins.push(record);
  const command = (
    name: string,
    duplex?: true | "optional",
    owner = { id: record.id, source: record.source },
  ) =>
    registry.nodeHostCommands.push({
      pluginId: owner.id,
      source: owner.source,
      command: { command: name, ...(duplex ? { duplex } : {}), handle: async () => "{}" },
    });
  command("file.fetch");
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  const resolveContext = () => context;
  const subagent = {} as PluginRuntime["subagent"];
  const gateway = options.gateway ?? "bound";
  if (gateway === "bound") {
    bindGatewayContextResolver(subagent, resolveContext);
  }
  if (gateway !== "absent") {
    bindPluginRegistryRuntime(
      registry,
      createLazyPluginRuntime(gateway === "bound" ? { runtimeOptions: { subagent } } : {}),
    );
  }
  markPluginRegistryActive(registry);
  let serviceContext: OpenClawPluginServiceContext | undefined;
  registry.services.push({
    id: "files-service",
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      id: "files-service",
      start: (ctx) => {
        serviceContext = ctx;
      },
      stop: options.stop,
    },
  });
  const handle = await startPluginServices({ registry, config: {} });
  handles.add(handle);
  assert(serviceContext, "Service did not start");
  const nodeHandler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name: "node.invoke",
        scope: "operator.write",
        owner: { kind: "core", area: "nodes" },
        handler: nodeHandler,
      },
      {
        name: "agents.files.get",
        scope: "operator.read",
        owner: { kind: "core", area: "agents" },
        handler: async ({ respond }: GatewayRequestHandlerOptions) => {
          respond(true, await serviceContext!.invokeNode!(request));
        },
      },
    ]);
  return {
    registry,
    record,
    context,
    resolveContext,
    serviceContext,
    handle,
    nodeHandler,
    command,
  };
}

const request = {
  nodeId: "paired-node",
  command: "file.fetch",
  params: { path: "/workspace/AGENTS.md" },
};

describe("service-owned node invocation", () => {
  it("releases retiring callers while stopped node capabilities remain reachable", async () => {
    type NodeInvoker = NonNullable<ReturnType<typeof createPluginServiceNodeInvoker>>;
    class RetiringCaller {
      stop(invoker: NodeInvoker) {
        invoker.stop();
      }
    }
    const { registry, record } = await startFixture();
    const invokers = Array.from({ length: 12 }, () => {
      const invoker = createPluginServiceNodeInvoker({
        registry,
        record,
        lease: createPluginRuntimeCapabilityLease("retained node capability"),
        isStopping: () => false,
      });
      assert(invoker, "Node invoker was not created");
      new RetiringCaller().stop(invoker);
      return invoker;
    });
    // Inspect retention before any error matcher can materialize the lazy stack.
    expect(queryObjects(RetiringCaller)).toBe(0);
    for (const invoker of invokers) {
      const reason: unknown = await invoker.invoke(request).catch((error: unknown) => error);
      expect(reason).toBeInstanceOf(Error);
      expect(reason).toMatchObject({ message: "Plugin service node access stopped" });
      await expect(invoker.invoke(request)).rejects.toBe(reason);
      await expect(invoker.openDuplex(request)).rejects.toBe(reason);
    }
  });

  it.each([false, true])("isolates profile-backed=%s readers", async (profileBacked) => {
    await withOpenClawTestState({}, async () => {
      const { context, nodeHandler } = await startFixture();
      const profile = ensureProfileForEmail("reader@example.test");
      setUserProfileRole(profile.id, "limited");
      const authenticatedUserProfile = profileBacked
        ? { profileId: profile.id, displayName: "reader", hasAvatar: false, updatedAt: 1 }
        : undefined;
      const reader = createSyntheticPluginRuntimeClient({
        scopes: ["operator.read"],
        authenticatedUserProfile,
      });
      const expectReadOnly = () =>
        expect(dispatchGatewayMethodInProcess("node.invoke", request)).rejects.toThrow(
          /scope|permission/i,
        );
      const run = async () => {
        await expectReadOnly();
        await expect(
          dispatchGatewayRequestInProcess(
            "agents.files.get",
            {},
            {
              client: reader,
              context,
              methodRegistry: context.getGatewayMethodRegistry!(),
            },
          ),
        ).resolves.toEqual({ ok: true });
        expect(nodeHandler).toHaveBeenCalledOnce();
        const calledClient = nodeHandler.mock.calls[0]![0].client;
        expect(calledClient?.connect.scopes).toEqual(["operator.write"]);
        expect(calledClient?.internal).toMatchObject({
          operatorRoleActor: { kind: "system" },
          pluginRuntimeOwnerId: "files",
        });
        expect(calledClient?.authenticatedUserProfile).toBeUndefined();
        await expectReadOnly();
      };
      await withPluginRuntimeGatewayRequestScope(
        { client: reader, context, isWebchatConnect: () => false },
        () =>
          profileBacked
            ? withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: authenticatedUserProfile!,
                  scopes: ["operator.read"],
                },
                run,
              )
            : run(),
      );
    });
  });

  it.each(["absent", "unbound"] as const)("omits access from an %s host", async (gateway) => {
    const loadRuntime = vi
      .spyOn(nativeModuleRequire, "tryNativeRequireModule")
      .mockImplementation(() => {
        throw new Error("Service metadata must not load the broad runtime");
      });
    try {
      const foreign = await startFixture();
      await withPluginRuntimeGatewayRequestScope(
        {
          context: foreign.context,
          resolveGatewayContext: foreign.resolveContext,
          isWebchatConnect: () => false,
        },
        async () => {
          const { serviceContext } = await startFixture({ gateway });
          expect(serviceContext.invokeNode).toBeUndefined();
          expect(serviceContext.openNodeDuplex).toBeUndefined();
          expect(loadRuntime).not.toHaveBeenCalled();
        },
      );
    } finally {
      loadRuntime.mockRestore();
    }
  });

  it("retains exact service authority across an unrelated registry replacement", async () => {
    const fixture = await startFixture();
    const next = createEmptyPluginRegistry();
    next.plugins.push(fixture.record);
    next.services.push(...fixture.registry.services);
    next.nodeHostCommands.push(...fixture.registry.nodeHostCommands);
    adoptPluginRegistryRecords(next);
    markPluginRegistryActive(next);
    markPluginRegistryRetired(fixture.registry);
    const successor = await startPluginServices({
      registry: next,
      config: {},
      previous: fixture.handle,
    });
    handles.add(successor);
    await fixture.handle.stop();
    await expect(fixture.serviceContext.invokeNode!(request)).resolves.toEqual({ ok: true });
    await successor.stop();
    await expect(fixture.serviceContext.invokeNode!(request)).rejects.toThrow();
  });

  it("aborts pending dispatch before slow service cleanup finishes", async () => {
    const cleanup = createDeferredCore();
    const entered = createDeferredCore<AbortSignal>();
    const fixture = await startFixture({ stop: () => cleanup.promise });
    fixture.nodeHandler.mockImplementation(async ({ signal, respond }) => {
      entered.resolve(signal!);
      await once(signal!, "abort");
      respond(false, undefined, { code: "UNAVAILABLE", message: "cancelled" });
    });
    const pending = fixture.serviceContext.invokeNode!(request);
    const rejected = expect(pending).rejects.toThrow();
    const signal = await entered.promise;
    const stopping = fixture.handle.stop();
    try {
      expect(signal.aborted).toBe(true);
      await rejected;
      await expect(fixture.serviceContext.invokeNode!(request)).rejects.toThrow();
    } finally {
      cleanup.resolve();
      await stopping;
    }
  });
});

async function openServiceDuplex(
  options: { assertCurrent?: () => void; duplex?: true | "optional" } = {},
) {
  const fixture = await startFixture();
  fixture.command("file.create", options.duplex ?? true);
  const dispatched = createDeferredCore<GatewayRequestHandlerOptions>();
  const finish = createDeferredCore();
  fixture.nodeHandler.mockImplementation(async (ctx) => {
    dispatched.resolve(ctx);
    const cancelled = once(ctx.signal!, "abort");
    await Promise.race([finish.promise, cancelled]);
    ctx.respond(true, { ok: true });
  });
  const sendInvokeInput = vi.fn();
  fixture.context.nodeRegistry = {
    sendInvokeInput,
  } as unknown as GatewayRequestContext["nodeRegistry"];
  const opening = fixture.serviceContext.openNodeDuplex!({
    ...request,
    command: "file.create",
    maxMessageBytes: 128 * 1024,
    assertCurrent: options.assertCurrent,
  });
  const ctx = await dispatched.promise;
  const stream = ctx.client!.internal!.nodeInvokeStream!;
  stream.onDispatchReady("preflight");
  // A non-mutating preflight has no receiver and must not open the channel.
  let ready = false;
  void opening.then(() => {
    ready = true;
  });
  await setImmediate();
  expect(ready).toBe(false);
  stream.onDispatchReady("upload");
  const endpoint = createNodeDuplexEndpoint({
    sendFrame: (frame) => stream.onProgress(JSON.stringify(frame)),
  });
  await endpoint.sendReady();
  const channel = await opening;
  sendInvokeInput.mockImplementation((id, frame) => {
    expect(id).toBe("upload");
    endpoint.receive(JSON.stringify(frame));
  });
  return { ...fixture, channel, ctx, finish, endpoint, sendInvokeInput };
}

describe("service-owned node duplex", () => {
  it.each(["listener", "send", "concurrent send"] as const)(
    "preserves rejection during %s setup",
    async (operation) => {
      const { channel, ctx, finish, sendInvokeInput } = await openServiceDuplex();
      const pairingChanged = {
        code: "UNAVAILABLE",
        message: "node pairing changed while invocation was active",
        retryable: true,
        details: { code: "PAIRING_CHANGED" },
      };
      try {
        if (operation === "concurrent send") {
          const retired = new NodeRegistry();
          sendInvokeInput.mockImplementation((id, frame) => {
            retired.sendInvokeInput(id, frame);
          });
        }
        ctx.respond(false, undefined, pairingChanged);
        if (operation !== "concurrent send") {
          await expect(channel.closed).rejects.toMatchObject(pairingChanged);
        }

        const setup =
          operation === "listener"
            ? Promise.resolve().then(() => channel.onMessage(vi.fn()))
            : channel.send(Uint8Array.of(1));
        await expect(setup).rejects.toMatchObject(pairingChanged);
        expect(() => channel.onMessage(vi.fn())).toThrow(pairingChanged.message);
        if (operation === "concurrent send") {
          expect(sendInvokeInput).toHaveBeenCalledOnce();
          await expect(channel.closed).rejects.toMatchObject(pairingChanged);
        } else {
          expect(sendInvokeInput).not.toHaveBeenCalled();
        }
      } finally {
        finish.resolve();
      }
    },
  );

  it.each([true, "optional"] as const)("supports %s duplex", async (duplex) => {
    const { channel, endpoint, ctx, finish, sendInvokeInput } = await openServiceDuplex({ duplex });
    const received: Uint8Array[] = [];
    endpoint.onMessage((message) => {
      received.push(message);
    });
    const source = Buffer.alloc(128 * 1024, 7);
    await channel.send(source);
    expect(received.map((message) => Buffer.from(message))).toEqual([source]);
    expect(sendInvokeInput).toHaveBeenCalledTimes(16);
    expect(ctx.client?.internal).toMatchObject({
      pluginRuntimeOwnerId: "files",
      operatorRoleActor: { kind: "system" },
    });
    finish.resolve();
    await expect(channel.closed).resolves.toEqual({ ok: true });
    await expect(channel.send(source)).rejects.toThrow(/closed/);
  });

  it.each(["stop", "gateway", "replace", "caller"])("revokes on %s", async (action) => {
    let current = true;
    const fixture = await openServiceDuplex({
      assertCurrent() {
        if (!current) {
          throw new Error("turn no longer current");
        }
      },
    });
    const closed = expect(fixture.channel.closed).rejects.toThrow();
    if (action === "stop") {
      await fixture.handle.stop();
    }
    if (action === "gateway") {
      getGatewayContextLifetime(fixture.resolveContext).abort();
    }
    if (action === "replace") {
      revokePluginRecord(fixture.registry, fixture.record);
    }
    if (action === "caller") {
      current = false;
    }
    await expect(fixture.channel.send(Uint8Array.of(1))).rejects.toThrow();
    await closed;
    if (action !== "caller") {
      await expect(
        fixture.serviceContext.invokeNode!({ ...request, command: "file.create" }),
      ).rejects.toThrow();
      expect(fixture.nodeHandler).toHaveBeenCalledOnce();
    }
    expect(fixture.sendInvokeInput).not.toHaveBeenCalled();
    expect(fixture.ctx.signal?.aborted).toBe(true);
  });

  it("rejects non-duplex and unowned commands before dispatch", async () => {
    const fixture = await startFixture();
    fixture.command("other.stream", true, { id: "other", source: "other" });
    for (const command of ["file.fetch", "system.run", "other.stream"]) {
      await expect(fixture.serviceContext.openNodeDuplex!({ ...request, command })).rejects.toThrow(
        command === "file.fetch" ? /duplex/ : /unowned/,
      );
      if (command !== "file.fetch") {
        await expect(fixture.serviceContext.invokeNode!({ ...request, command })).rejects.toThrow(
          /unowned/,
        );
      }
    }
    expect(fixture.nodeHandler).not.toHaveBeenCalled();
  });
});

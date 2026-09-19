import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
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
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
import { startPluginServices, type PluginServicesHandle } from "./services.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const handles = new Set<PluginServicesHandle>();
afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
});

async function startFixture(options: { stop?: () => Promise<void>; bound?: boolean } = {}) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "files" });
  registry.plugins.push(record);
  registry.nodeHostCommands.push({
    pluginId: record.id,
    source: record.source,
    command: { command: "file.fetch", handle: async () => "{}" },
  });
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  const resolveContext = () => context;
  const subagent = {} as PluginRuntime["subagent"];
  if (options.bound !== false) {
    bindGatewayContextResolver(subagent, resolveContext);
    bindPluginRegistryRuntime(registry, { subagent } as PluginRuntime);
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
  if (!serviceContext) {
    throw new Error("Service did not start");
  }
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
  return { registry, record, context, resolveContext, serviceContext, handle, nodeHandler };
}

const request = {
  nodeId: "paired-node",
  command: "file.fetch",
  params: { path: "/workspace/AGENTS.md" },
};

describe("service-owned node invocation", () => {
  it.each([false, true])(
    "preserves document read access for a profile-backed=%s reader",
    async (profileBacked) => {
      await withOpenClawTestState({}, async () => {
        const fixture = await startFixture();
        const profile = ensureProfileForEmail("reader@example.test");
        setUserProfileRole(profile.id, "limited");
        const reader = createSyntheticPluginRuntimeClient({
          scopes: ["operator.read"],
          ...(profileBacked
            ? {
                authenticatedUserProfile: {
                  profileId: profile.id,
                  displayName: "reader",
                  hasAvatar: false,
                  updatedAt: 1,
                },
              }
            : {}),
        });
        const run = async () => {
          await expect(dispatchGatewayMethodInProcess("node.invoke", request)).rejects.toThrow(
            /scope|permission/i,
          );
          await expect(
            dispatchGatewayRequestInProcess(
              "agents.files.get",
              {},
              {
                client: reader,
                context: fixture.context,
                methodRegistry: fixture.context.getGatewayMethodRegistry!(),
              },
            ),
          ).resolves.toEqual({ ok: true });
          expect(fixture.nodeHandler).toHaveBeenCalledOnce();
          const calledClient = fixture.nodeHandler.mock.calls[0]![0].client;
          expect(calledClient?.connect.scopes).toEqual(["operator.write"]);
          expect(calledClient?.internal).toMatchObject({
            operatorRoleActor: { kind: "system" },
            pluginRuntimeOwnerId: "files",
          });
          expect(calledClient?.authenticatedUserProfile).toBeUndefined();
          await expect(dispatchGatewayMethodInProcess("node.invoke", request)).rejects.toThrow(
            /scope|permission/i,
          );
        };
        await withPluginRuntimeGatewayRequestScope(
          { client: reader, context: fixture.context, isWebchatConnect: () => false },
          () =>
            profileBacked
              ? withOperatorToolGatewayAuthority(
                  {
                    authenticatedUserProfile: reader.authenticatedUserProfile!,
                    scopes: ["operator.read"],
                  },
                  run,
                )
              : run(),
        );
      });
    },
  );

  it("omits node access outside a Gateway host", async () => {
    expect((await startFixture({ bound: false })).serviceContext.invokeNode).toBeUndefined();
  });

  it("rejects core and other-plugin commands", async () => {
    const fixture = await startFixture();
    fixture.registry.nodeHostCommands.push({
      pluginId: "other",
      source: "other",
      command: { command: "other.read", handle: async () => "{}" },
    });
    for (const command of ["system.run", "other.read"]) {
      await expect(fixture.serviceContext.invokeNode!({ ...request, command })).rejects.toThrow(
        /unowned/,
      );
    }
    expect(fixture.nodeHandler).not.toHaveBeenCalled();
  });

  it.each(["stop", "gateway", "replace"])(
    "rejects a retained capability after %s",
    async (action) => {
      const fixture = await startFixture();
      await fixture.serviceContext.invokeNode!(request);
      if (action === "stop") {
        await fixture.handle.stop();
      }
      if (action === "gateway") {
        getGatewayContextLifetime(fixture.resolveContext).abort();
      }
      if (action === "replace") {
        revokePluginRecord(fixture.registry, fixture.record);
      }
      await expect(fixture.serviceContext.invokeNode!(request)).rejects.toThrow();
      expect(fixture.nodeHandler).toHaveBeenCalledOnce();
    },
  );

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
      await new Promise<void>((resolve) => {
        signal!.addEventListener("abort", () => resolve(), { once: true });
      });
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
  fixture.registry.nodeHostCommands.push({
    pluginId: fixture.record.id,
    source: fixture.record.source,
    command: { command: "file.create", duplex: options.duplex ?? true, handle: async () => "{}" },
  });
  const dispatched = createDeferredCore<GatewayRequestHandlerOptions>();
  const finish = createDeferredCore();
  fixture.nodeHandler.mockImplementation(async (ctx) => {
    dispatched.resolve(ctx);
    const cancelled = new Promise<void>((resolve) => {
      ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
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
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
  it.each([true, "optional"] as const)(
    "uses %s duplex after canonical preflight",
    async (duplex) => {
      const fixture = await openServiceDuplex({ duplex });
      const received: Uint8Array[] = [];
      fixture.endpoint.onMessage((message) => {
        received.push(message);
      });
      const source = Buffer.alloc(128 * 1024, 7);
      await fixture.channel.send(source);
      expect(received.map((message) => Buffer.from(message))).toEqual([source]);
      expect(fixture.sendInvokeInput).toHaveBeenCalledTimes(16);
      expect(fixture.ctx.client?.internal).toMatchObject({
        pluginRuntimeOwnerId: "files",
        operatorRoleActor: { kind: "system" },
      });
      fixture.finish.resolve();
      await expect(fixture.channel.closed).resolves.toEqual({ ok: true });
      await expect(fixture.channel.send(source)).rejects.toThrow(/closed/);
    },
  );

  it.each(["stop", "gateway", "replace", "caller"])(
    "stops retained sends and pending dispatch on %s revocation",
    async (action) => {
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
      expect(fixture.sendInvokeInput).not.toHaveBeenCalled();
      expect(fixture.ctx.signal?.aborted).toBe(true);
    },
  );

  it("rejects non-duplex and unowned commands before dispatch", async () => {
    const fixture = await startFixture();
    for (const command of ["file.fetch", "system.run", "other.stream"]) {
      await expect(
        fixture.serviceContext.openNodeDuplex!({ ...request, command }),
      ).rejects.toThrow();
    }
    expect(fixture.nodeHandler).not.toHaveBeenCalled();
  });
});

import assert from "node:assert/strict";
import path from "node:path";
import { Type } from "typebox";
import { expect, it, onTestFinished, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { normalizeProviderToolSchemasWithPlugin } from "./provider-runtime.js";
import { channelFixture } from "./registry-registration.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { SessionCatalogContinueProviderResult } from "./session-catalog.js";
import type { AnyAgentTool } from "./types.js";
import { mapRegistryProviders } from "./web-provider-resolution-shared.js";

function createOwner(nativeCatalog = false, id = "factory-owner") {
  const runtime = nativeCatalog ? createPluginRuntime() : undefined;
  if (runtime) {
    runtime.config.current = () => ({
      plugins: { entries: { "factory-owner": { config: { sessionCatalog: { enabled: true } } } } },
    });
  }
  const builder = createTestPluginRegistry(runtime);
  const record = createPluginRecord({
    id,
    nativeSessionCatalog: nativeCatalog
      ? { label: "Factory catalog", nodeCommands: [] }
      : undefined,
    source: "/synthetic/factory-owner.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: {
      tools: ["factory_tool", "factory_tool_second"],
      webSearchProviders: ["factory-search"],
    },
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  const consumers: ReturnType<typeof instance.retainConsumer>[] = [];
  onTestFinished(async () => {
    for (const consumer of consumers) {
      consumer.release();
    }
    await instance.dispose();
  });
  const retainConsumer = () => {
    const consumer = instance.retainConsumer();
    consumers.push(consumer);
    return consumer;
  };
  const expectScope = () => {
    expect(instance.hasActiveCall).toBe(true);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(record.id);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(builder.registry);
  };
  return { builder, api, instance, expectScope, retainConsumer };
}

function createTools(expectScope: () => void) {
  const names = ["factory_tool", "factory_tool_second"];
  const payloads = names.map((name) => ({
    content: [{ type: "text" as const, text: name }],
    details: { read: () => name },
  }));
  class Tool {
    name: string;
    label = "Factory tool";
    description = "Read synthetic factory data";
    parameters = Type.Object({});
    #result: (typeof payloads)[number];

    constructor(index: number) {
      this.name = names[index]!;
      this.#result = payloads[index]!;
    }

    async execute(_callId: string, _args: unknown) {
      expectScope();
      await Promise.resolve();
      expectScope();
      return this.#result;
    }
  }
  return { names, payloads, tools: names.map((_, index) => new Tool(index)) };
}

it("keeps provider-normalized tool data native and execution bound to its owner", async () => {
  const { builder, api, instance, expectScope } = createOwner();
  const { payloads, tools } = createTools(expectScope);
  api.registerProvider({
    id: "factory-provider",
    label: "Factory provider",
    auth: [],
    normalizeToolSchemas({ tools: input }) {
      expectScope();
      expect(this.id).toBe("factory-provider");
      return input;
    },
  });
  const plugin = builder.registry.providers[0]!.provider;
  const normalize = () =>
    normalizeProviderToolSchemasWithPlugin({
      provider: plugin.id,
      runtimeHandle: { provider: plugin.id, plugin },
      allowRuntimePluginLoad: false,
      context: { provider: plugin.id, tools },
    });
  const normalized = normalize();
  assert(normalized);
  for (const [index, tool] of normalized.entries()) {
    expect(tool.parameters).toBe(tools[index]!.parameters);
    const execute = tool.execute;
    expect(await execute("normalized-call", {})).toBe(payloads[index]);
  }
  await instance.dispose();
  expect(normalize).toThrow("reloaded or disabled");
  expect(() => normalized[0]!.execute("retired-call", {})).toThrow("reloaded or disabled");
});

it.each(["sync", "callback"] as const)(
  "attributes a retained %s store's deprecation to the opening plugin",
  async (kind) => {
    await withOpenClawTestState({ label: `runtime-store-warning-${kind}` }, async ({ env }) => {
      const pluginId = `runtime-store-warning-${kind}`;
      const { api, instance } = createOwner(false, pluginId);
      const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const warning = (method: string) => [
        expect.stringContaining(`Plugin ${pluginId}: ${method}`),
        expect.objectContaining({ type: "DeprecationWarning", code: "DEP_PLUGIN_SDK" }),
      ];
      try {
        const useLegacyStore = instance.run(() => {
          const options = { namespace: "warning", maxEntries: 2, env };
          if (kind === "sync") {
            const store = api.runtime.state.openSyncKeyedStore<number>(options);
            return () => store.lookup("missing");
          }
          const store = api.runtime.state.openKeyedStore<number>(options);
          const update = store.update;
          assert(update);
          return () => update("counter", (current) => (current ?? 0) + 1);
        });
        const opened = kind === "sync" ? [warning("api.runtime.state.openSyncKeyedStore")] : [];
        expect(emitWarning.mock.calls).toEqual(opened);
        await useLegacyStore();
        await useLegacyStore();
        const method =
          kind === "sync" ? "PluginStateSyncKeyedStore.lookup" : "PluginStateKeyedStore.update";
        expect(emitWarning.mock.calls).toEqual([...opened, warning(method)]);
      } finally {
        emitWarning.mockRestore();
        await instance.dispose();
      }
    });
  },
);

it.each(["static", "factory", "channel", "apply", "bind"] as const)(
  "binds %s tool results to their consumer without wrapping data",
  async (kind) => {
    const { builder, api, instance, expectScope, retainConsumer } = createOwner();
    const { names, payloads, tools } = createTools(expectScope);
    const consumer = retainConsumer();
    let scoped: AnyAgentTool[];
    let root: () => AnyAgentTool[];
    let rootExecutions: AnyAgentTool["execute"][] | undefined;
    if (kind === "channel") {
      api.registerChannel({
        plugin: { ...channelFixture("factory-channel", "Factory channel"), agentTools: tools },
      });
      const channel = builder.registry.channels[0]!.plugin;
      const resolve = (value: typeof channel) => {
        const entry = value.agentTools;
        assert(entry);
        return typeof entry === "function" ? entry({}) : entry;
      };
      scoped = resolve(consumer.wrap(channel));
      root = () => resolve(channel);
    } else {
      const create = () => {
        expectScope();
        return kind === "factory" ? tools : tools[0]!;
      };
      api.registerTool(
        kind === "static" ? tools[0]! : kind === "factory" ? { contextVersion: 2, create } : create,
        {
          names: kind === "static" ? names.slice(0, 1) : names,
          workspaceAccess: kind === "static" || kind === "factory" ? true : undefined,
        },
      );
      expect(builder.registry.tools[0]?.workspaceAccess).toBe(true);
      const factory = builder.registry.tools[0]!.factory;
      const context = { assertInvocationCurrent() {} };
      // oxlint-disable-next-line no-useless-call -- Exercise Function.prototype.apply at the factory boundary.
      const rootResult = kind === "apply" ? factory.apply(undefined, [{}]) : factory(context);
      assert(rootResult);
      const rootTools = Array.isArray(rootResult) ? rootResult : [rootResult];
      rootExecutions = rootTools.map((tool) => tool.execute);
      root = () => rootTools;
      const result =
        kind === "bind"
          ? consumer.wrap(factory.bind(undefined, {}))()
          : consumer.wrap(factory)(context);
      assert(result);
      scoped = Array.isArray(result) ? result : [result];
    }
    expect(builder.registry.diagnostics).toEqual([]);
    const delivered: Array<{ details: unknown }> = [];
    const retained = scoped.map((tool) => tool.execute);
    expect(retained).toHaveLength(kind === "factory" || kind === "channel" ? 2 : 1);
    for (const [index, tool] of scoped.entries()) {
      expect(tool.name).toBe(names[index]);
      const result = await retained[index]!("synthetic-call", {});
      expect(result).toBe(payloads[index]);
      delivered.push(result);
    }
    consumer.release();
    for (const execute of retained) {
      expect(() => execute("late-call", {})).toThrow("consumer is closed");
    }
    rootExecutions ??= root().map((tool) => tool.execute);
    for (const [index, execute] of rootExecutions.entries()) {
      expect(await execute("live-root-call", {})).toBe(payloads[index]);
    }
    await instance.dispose();
    for (const execute of rootExecutions) {
      expect(() => execute("retired-call", {})).toThrow("reloaded or disabled");
    }
    for (const [index, result] of delivered.entries()) {
      expect(result.details).toBe(payloads[index]!.details);
      expect(payloads[index]!.details.read()).toBe(names[index]);
    }
    if (kind === "bind") {
      expect(() => retained[0]!("retired-consumer", {})).toThrow("consumer is closed");
    }
  },
);

it.each([false, true])(
  "keeps catalog continuation data native and its callback scoped (native gate: %s)",
  async (nativeCatalog) => {
    const { builder, api, instance, expectScope, retainConsumer } = createOwner(nativeCatalog);
    const consumer = retainConsumer();
    const upstream = {
      kind: "codex-app-server" as const,
      ref: { threadId: "synthetic-thread", nested: ["source"] },
      marker: { lastTurnId: "synthetic-turn" },
    };
    const conversationBinding = { data: { source: "synthetic-binding" } };
    const plain = { sessionKey: "synthetic-session", upstream, conversationBinding };
    const result: SessionCatalogContinueProviderResult = {
      ...plain,
      async afterConversationBound() {
        expectScope();
        await Promise.resolve();
        expectScope();
      },
    };
    let next = result;
    api.registerSessionCatalog({
      id: "factory-catalog",
      label: "Factory catalog",
      supportsProcessHomeIsolation: true,
      list: async () => [],
      read: async () => ({ hostId: "synthetic-host", threadId: "synthetic-thread", items: [] }),
      async continueSession() {
        expectScope();
        return next;
      },
    });
    expect(builder.registry.diagnostics).toEqual([]);
    const provider = builder.registry.sessionCatalogs[0]!.provider;
    const request = { hostId: "synthetic-host", threadId: "synthetic-thread" };
    const root = await provider.continueSession!(request);
    const retained = await consumer.wrap(provider).continueSession!(request);
    for (const value of [root, retained]) {
      expect(value.upstream).toBe(upstream);
      expect(value.conversationBinding).toBe(conversationBinding);
      expect(structuredClone(value.upstream)).toEqual(upstream);
      expect(structuredClone(value.conversationBinding)).toEqual(conversationBinding);
    }
    const rootCallback = root.afterConversationBound!;
    const consumerCallback = retained.afterConversationBound!;
    await consumerCallback();
    next = plain;
    expect(await provider.continueSession!(request)).toBe(plain);
    consumer.release();
    expect(() => consumerCallback()).toThrow("consumer is closed");
    await rootCallback();
    await instance.dispose();
    expect(() => rootCallback()).toThrow("reloaded or disabled");
    expect(structuredClone(upstream)).toEqual(upstream);
  },
);

it("binds a resolved provider factory without wrapping its execution data", async () => {
  const { builder, api, instance, expectScope } = createOwner();
  const payload = { results: [{ title: "Synthetic result" }], read: () => "retained result" };
  class SearchTool {
    description = "Search synthetic data";
    parameters = Type.Object({});
    #result = payload;

    async execute(_args: Record<string, unknown>) {
      expectScope();
      await Promise.resolve();
      expectScope();
      return this.#result;
    }
  }
  api.registerWebSearchProvider({
    id: "factory-search",
    label: "Factory search",
    hint: "Synthetic provider",
    envVars: [],
    placeholder: "",
    signupUrl: "https://example.test",
    credentialPath: "plugins.entries.factory-owner.config.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue() {},
    createTool() {
      expectScope();
      return new SearchTool();
    },
  });
  expect(builder.registry.diagnostics).toEqual([]);
  const [provider] = mapRegistryProviders({
    registry: builder.registry,
    entries: builder.registry.webSearchProviders,
  });
  assert(provider);
  const tool = provider.createTool({});
  assert(tool);
  const execute = tool.execute;
  const result = await execute({ query: "synthetic" });
  expect(result).toBe(payload);
  await instance.dispose();
  expect(() => execute({ query: "late" })).toThrow("reloaded or disabled");
  expect(payload.read()).toBe("retained result");
});
it("preserves the selected main entry during setup registration without guessing an unselected entry", () => {
  const builder = createTestPluginRegistry(createPluginRuntime());
  const rootDir = path.resolve("plugins/fixture");
  const source = path.join(rootDir, "index.ts");
  const record = createPluginRecord({
    id: "fixture",
    source,
    rootDir,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  expect(builder.createApi(record, { config: {} }).runtimeSource).toBeUndefined();

  const runtimeSource = path.join(rootDir, "dist/index.js");
  bindPluginRuntimeArtifactSelection(record, {
    runtimeEntry: { source: runtimeSource, rootDir },
    setupEntry: { source: path.join(rootDir, "dist/setup.js"), rootDir },
  });
  const api = builder.createApi(record, { config: {}, registrationMode: "setup-runtime" });
  expect(api).toMatchObject({ runtimeSource, source, rootDir });
});

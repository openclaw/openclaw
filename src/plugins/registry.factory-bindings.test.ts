import assert from "node:assert/strict";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { SessionCatalogContinueProviderResult } from "./session-catalog.js";
import { mapRegistryProviders } from "./web-provider-resolution-shared.js";

function createOwner(nativeCatalog = false) {
  const runtime = nativeCatalog ? createPluginRuntime() : undefined;
  if (runtime) {
    runtime.config.current = () => ({
      plugins: { entries: { "factory-owner": { config: { sessionCatalog: { enabled: true } } } } },
    });
  }
  const builder = createTestPluginRegistry(runtime);
  const record = createPluginRecord({
    id: "factory-owner",
    ...(nativeCatalog
      ? { nativeSessionCatalog: { label: "Factory catalog", nodeCommands: [] } }
      : {}),
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
  const expectScope = () => {
    expect(instance.hasActiveCall).toBe(true);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(record.id);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(builder.registry);
  };
  return { builder, api, instance, expectScope };
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

describe("registered plugin factory bindings", () => {
  it.each([
    { kind: "static", shape: "single" } as const,
    { kind: "version 2", shape: "array" } as const,
  ])(
    "binds a $kind tool factory's $shape result to its consumer while data crosses by reference",
    async ({ kind, shape }) => {
      const { builder, api, instance, expectScope } = createOwner();
      const { names, payloads, tools } = createTools(expectScope);
      const consumer = instance.retainConsumer();
      const create = () => {
        expectScope();
        return shape === "array" ? tools : tools[0]!;
      };
      try {
        api.registerTool(kind === "static" ? tools[0]! : { contextVersion: 2, create }, {
          names: shape === "single" ? names.slice(0, 1) : names,
        });
        expect(builder.registry.diagnostics).toEqual([]);
        const factory = builder.registry.tools[0]!.factory;
        const context = { assertInvocationCurrent() {} };
        const rootResult = factory(context);
        assert(rootResult);
        const rootExecutions = (Array.isArray(rootResult) ? rootResult : [rootResult]).map(
          (tool) => tool.execute,
        );
        const resolved = consumer.wrap(factory)(context);
        assert(resolved);
        const retained: Array<() => Promise<unknown>> = [];
        const delivered: Array<{ details: unknown }> = [];
        for (const tool of Array.isArray(resolved) ? resolved : [resolved]) {
          const execute = tool.execute;
          const result = await execute("synthetic-call", {});
          expect(tool.name).toBe(names[retained.length]);
          expect(result).toBe(payloads[retained.length]);
          delivered.push(result);
          retained.push(() => execute("late-call", {}));
        }
        expect(retained).toHaveLength(shape === "array" ? 2 : 1);
        consumer.release();
        for (const execute of retained) {
          expect(execute).toThrow("consumer is closed");
        }
        for (const [index, execute] of rootExecutions.entries()) {
          expect(await execute("live-root-call", {})).toBe(payloads[index]);
        }
        await instance.dispose();
        for (const execute of rootExecutions) {
          expect(() => execute("retired-root-call", {})).toThrow("reloaded or disabled");
        }
        for (const [index, result] of delivered.entries()) {
          expect(result.details).toBe(payloads[index]!.details);
          expect(payloads[index]!.details.read()).toBe(names[index]);
        }
      } finally {
        consumer.release();
        await instance.dispose();
      }
    },
  );

  it.each(["apply", "bind"] as const)(
    "keeps registered factory results executable through Function.%s",
    async (helper) => {
      const { builder, api, instance, expectScope } = createOwner();
      const { names, payloads, tools } = createTools(expectScope);
      const consumer = helper === "bind" ? instance.retainConsumer() : undefined;
      try {
        api.registerTool(
          () => {
            expectScope();
            return tools[0]!;
          },
          { names },
        );
        const factory = builder.registry.tools[0]!.factory;
        const invoke =
          helper === "bind"
            ? consumer!.wrap(factory.bind(undefined, {}))
            : // oxlint-disable-next-line no-useless-call -- The test exercises the boundary's Function.prototype.apply path.
              () => factory.apply(undefined, [{}]);
        const tool = invoke();
        assert(tool && !Array.isArray(tool));
        const execute = tool.execute;
        expect(await execute("synthetic-helper-call", {})).toBe(payloads[0]);
        if (consumer) {
          consumer.release();
          expect(() => execute("closed-consumer-call", {})).toThrow("consumer is closed");
        }
        await instance.dispose();
        expect(() => execute("late-helper-call", {})).toThrow(
          consumer ? "consumer is closed" : "reloaded or disabled",
        );
      } finally {
        consumer?.release();
        await instance.dispose();
      }
    },
  );

  it.each([false, true])(
    "keeps catalog continuation data native and its callback scoped (native gate: %s)",
    async (nativeCatalog) => {
      const { builder, api, instance, expectScope } = createOwner(nativeCatalog);
      const consumer = instance.retainConsumer();
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
      try {
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
      } finally {
        consumer.release();
        await instance.dispose();
      }
    },
  );

  it("binds static channel tool arrays before consumers iterate them", async () => {
    const { builder, api, instance, expectScope } = createOwner();
    const { names, payloads, tools } = createTools(expectScope);
    const consumer = instance.retainConsumer();
    try {
      api.registerChannel({
        plugin: {
          id: "factory-channel",
          meta: {
            id: "factory-channel",
            label: "Factory channel",
            selectionLabel: "Factory channel",
            docsPath: "/channels/factory-channel",
            blurb: "Synthetic channel",
          },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => [], resolveAccount: () => undefined },
          agentTools: tools,
        },
      });
      expect(builder.registry.diagnostics).toEqual([]);
      const channel = builder.registry.channels[0]!.plugin;
      const entry = consumer.wrap(channel).agentTools;
      assert(entry);
      const registered = typeof entry === "function" ? entry({}) : entry;
      const retained: Array<() => Promise<unknown>> = [];
      for (const tool of registered) {
        const execute = tool.execute;
        expect(tool.name).toBe(names[retained.length]);
        expect(await execute("synthetic-channel-call", {})).toBe(payloads[retained.length]);
        retained.push(() => execute("late-channel-call", {}));
      }
      expect(retained).toHaveLength(2);
      consumer.release();
      for (const execute of retained) {
        expect(execute).toThrow("consumer is closed");
      }
      const rootEntry = channel.agentTools;
      assert(rootEntry);
      const rootTools = typeof rootEntry === "function" ? rootEntry({}) : rootEntry;
      const rootExecutions = rootTools.map((tool) => tool.execute);
      for (const [index, execute] of rootExecutions.entries()) {
        expect(await execute("live-root-channel-call", {})).toBe(payloads[index]);
      }
      await instance.dispose();
      for (const execute of rootExecutions) {
        expect(() => execute("retired-root-channel-call", {})).toThrow("reloaded or disabled");
      }
    } finally {
      consumer.release();
      await instance.dispose();
    }
  });

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
    try {
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
    } finally {
      await instance.dispose();
    }
  });
});

describe("plugin API runtime entrypoint", () => {
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
    expect(api.runtimeSource).toBe(runtimeSource);
    expect(api.source).toBe(source);
    expect(api.rootDir).toBe(rootDir);
  });
});

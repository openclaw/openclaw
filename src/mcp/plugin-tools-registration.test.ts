import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { acquireStandalonePluginToolRegistry } from "../plugins/tools.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { createCodexSupervisionToolsMcpServer } from "./codex-supervision-tools-serve.js";
import { createToolsMcpServer, serveRegisteredToolsMcpServer } from "./tools-stdio-server.js";

let sequence = 0;
function nativePlugin(options: { failDisposal?: boolean; abortSdk?: boolean } = {}) {
  useNoBundledPlugins();
  const key = `__mcp_registration_native_${sequence++}`;
  const state: {
    database?: DatabaseSync;
    disposals: number;
    factories: number;
    workspaceDir?: string;
    aborted: Deferred;
    started: Deferred;
    finish: Deferred;
    abortReason?: unknown;
    abortFailure?: unknown;
    abortRead?: unknown;
  } = {
    disposals: 0,
    factories: 0,
    aborted: createDeferredCore(),
    started: createDeferredCore(),
    finish: createDeferredCore(),
  };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id: "mcp-native",
    body: `const { DatabaseSync } = require("node:sqlite");
const { resolvePluginProviders } = require("openclaw/plugin-sdk/provider-catalog-runtime");
module.exports = { id: "mcp-native", register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const db = state.database = new DatabaseSync(":memory:");
  api.lifecycle.registerRuntimeLifecycle({ id: "native", dispose() {
    state.disposals++;
    db.close();
    if (${options.failDisposal === true}) throw new Error("synthetic registration disposal failure");
  }});
  api.registerProvider({ id: "mcp-native", label: "Native", auth: [],
    isCacheTtlEligible() { state.abortRead = db.prepare("SELECT 42 AS n").get().n; return true; }
  });
  api.registerTool(() => {
    state.factories++;
    return { name: "mcp_native_read", label: "Native read", description: "Native read",
      parameters: { type: "object", properties: {} },
      async execute(_id, _params, signal) {
        if (${options.abortSdk === true}) {
          signal.addEventListener("abort", () => {
            state.abortReason = signal.reason;
            try {
              const provider = resolvePluginProviders({ config: api.config, env: process.env,
                workspaceDir: state.workspaceDir, onlyPluginIds: ["mcp-native"], registryScope: "loaded"
              }).find((entry) => entry.id === "mcp-native");
              if (!provider || provider.isCacheTtlEligible({ provider: "mcp-native", modelId: "abort" }) !== true) {
                throw new Error("Abort callback lost its admitted provider registry");
              }
            } catch (error) { state.abortFailure = error; }
            finally { state.aborted.resolve(); }
          }, { once: true });
          state.started.resolve();
          await state.finish.promise;
        }
        return { content: [{ type: "text", text: String(db.prepare("SELECT 42 AS n").get().n) }] }; }
    };
  }, { names: ["mcp_native_read"] });
}};`,
  });
  state.workspaceDir = plugin.dir;
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      providers: [plugin.id],
      contracts: { tools: ["mcp_native_read"] },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  return {
    state,
    acquire: () =>
      acquireStandalonePluginToolRegistry({
        context: {
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              allow: [plugin.id],
              load: { paths: [plugin.file] },
              slots: { memory: "none" },
            },
          },
        },
      }),
    cleanup() {
      if (state.database?.isOpen) {
        state.database.close();
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function causes(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(causes);
  }
  return error instanceof Error && error.cause !== undefined ? causes(error.cause) : [error];
}

describe("MCP serving registration ownership", () => {
  it("keeps supplied tools usable across close/reconnect until their caller releases registration", async () => {
    const fixture = nativePlugin();
    const acquisition = await fixture.acquire();
    const server = createToolsMcpServer({
      name: "native-reconnect",
      tools: acquisition.resolveTools(),
    });
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const [outbound, inbound] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "native-client", version: "0.0.0" });
        try {
          await Promise.all([server.connect(inbound), client.connect(outbound)]);
          expect(await client.callTool({ name: "mcp_native_read" })).toMatchObject({
            content: [{ text: "42" }],
          });
        } finally {
          await server.close();
          await client.close();
        }
        expect(fixture.state.database?.isOpen).toBe(true);
        expect(fixture.state.disposals).toBe(0);
      }
      await acquisition.release();
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
    } finally {
      await server.close();
      await acquisition.release();
      fixture.cleanup();
    }
  });

  it("releases the native registration when supervision tool validation fails before connection", async () => {
    const fixture = nativePlugin();
    try {
      await expect(
        serveRegisteredToolsMcpServer({
          acquireRegistry: fixture.acquire,
          createServer: (tools) => createCodexSupervisionToolsMcpServer({ tools }),
        }),
      ).rejects.toThrow("Install or update @openclaw/codex");
      expect(fixture.state.factories).toBe(1);
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not revive an acquired view when the same registry objects are reactivated", async () => {
    const fixture = nativePlugin();
    const acquisition = await fixture.acquire();
    try {
      expect(acquisition.resolveTools()).toHaveLength(1);
      expect(fixture.state.factories).toBe(1);
      await acquisition.release();
      markPluginRegistryActive(acquisition.registry);
      expect(() => acquisition.resolveTools()).toThrow("Plugin tool registry has been released");
      expect(fixture.state.factories).toBe(1);
      expect(fixture.state.database?.isOpen).toBe(false);
    } finally {
      await acquisition.release();
      fixture.cleanup();
    }
  });

  it("keeps peer cancellation SDK borrows with the admitted host under a foreign ambient host", async () => {
    const fixture = nativePlugin({ abortSdk: true });
    const admittedHost = new LegacyPluginSdkResourceHost();
    const foreignHost = new LegacyPluginSdkResourceHost();
    const acquisition = await admittedHost.run(fixture.acquire);
    const server = withPluginRuntimeRegistryScope(acquisition.registry, () =>
      createToolsMcpServer({
        name: "native-peer-cancel",
        tools: admittedHost.run(acquisition.resolveTools),
        sdkResourceHost: admittedHost,
      }),
    );
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-peer", version: "0.0.0" });
    let call: Promise<unknown> | undefined;
    try {
      await Promise.all([server.connect(inbound), client.connect(outbound)]);
      const controller = new AbortController();
      call = client
        .callTool({ name: "mcp_native_read" }, undefined, { signal: controller.signal })
        .catch((error: unknown) => error);
      await Promise.race([
        fixture.state.started.promise,
        call.then(() => {
          throw new Error("The tool completed before native work started");
        }),
      ]);
      // The peer shares the registry but owns a different SDK lifetime.
      foreignHost.run(() =>
        withPluginRuntimeRegistryScope(acquisition.registry, () =>
          controller.abort("peer cancellation reason"),
        ),
      );
      await fixture.state.aborted.promise;
      fixture.state.finish.resolve();
      await server.close();
      await call;
      expect(fixture.state.abortReason).toBe("peer cancellation reason");
      expect(fixture.state.abortFailure).toBeUndefined();
      expect(fixture.state.abortRead).toBe(42);
      await acquisition.release();
      await admittedHost.close();
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
    } finally {
      fixture.state.finish.resolve();
      await server.close();
      await client.close();
      await call;
      await acquisition.release();
      await admittedHost.close();
      await foreignHost.close();
      fixture.cleanup();
    }
  });

  it.each([false, true])(
    "joins owned stdio self-close without replacing the caller callback (throws: %s)",
    async (throws) => {
      const fixture = nativePlugin();
      const closeError = new Error("caller close callback failed");
      let callbacks = 0;
      const onclose = () => {
        callbacks++;
        if (throws) {
          throw closeError;
        }
      };
      let server: ReturnType<typeof createToolsMcpServer> | undefined;
      let selfClose: Promise<unknown> | undefined;
      try {
        const servingFailure = await serveRegisteredToolsMcpServer({
          acquireRegistry: fixture.acquire,
          createServer(tools, sdkResourceHost) {
            server = createToolsMcpServer({ name: "native-self-close", tools, sdkResourceHost });
            // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server exposes callback properties, not EventTarget.
            server.onclose = onclose;
            const created = server;
            queueMicrotask(() => {
              const transport = created.transport;
              if (!transport) {
                throw new Error("Expected the connected owned stdio transport");
              }
              selfClose = transport.close().then(
                () => undefined,
                (error: unknown) => error,
              );
            });
            return server;
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(await selfClose).toBe(throws ? closeError : undefined);
        expect(servingFailure).toBe(throws ? closeError : undefined);
        expect(callbacks).toBe(1);
        expect(server?.onclose).toBe(onclose);
        expect(fixture.state.database?.isOpen).toBe(false);
        expect(fixture.state.disposals).toBe(1);
      } finally {
        await selfClose;
        await server?.close();
        fixture.cleanup();
      }
    },
  );

  it("preserves real SDK connect and transport-close errors while joining a failed native disposer once", async () => {
    const fixture = nativePlugin({ failDisposal: true });
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    const transportClose = inbound.close.bind(inbound);
    vi.spyOn(inbound, "close").mockImplementation(async () => {
      await transportClose();
      throw new Error("synthetic transport close failure");
    });
    const previousOnClose = vi.fn();
    let connection: Promise<void> | undefined;
    let server: ReturnType<typeof createToolsMcpServer> | undefined;
    try {
      const failure = await serveRegisteredToolsMcpServer({
        acquireRegistry: fixture.acquire,
        createServer(tools, sdkResourceHost) {
          server = createToolsMcpServer({ name: "failed-native", tools, sdkResourceHost });
          // The SDK rejects a second connection while this real transport is attached.
          // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server exposes a callback property, not EventTarget.
          server.onclose = previousOnClose;
          connection = server.connect(inbound);
          return server;
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await connection;
      const messages = causes(failure).map(String);
      expect(messages).toHaveLength(3);
      expect(messages.filter((message) => message.includes("Already connected"))).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes("synthetic transport close failure")),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes("synthetic registration disposal failure")),
      ).toHaveLength(1);
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
      expect(previousOnClose).toHaveBeenCalledOnce();
      expect(server?.onclose).toBe(previousOnClose);
    } finally {
      await outbound.close();
      fixture.cleanup();
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import * as schedulerModule from "../infra/gateway-scheduler.js";
import {
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../plugin-sdk/logging-core.js";
import { resolvePluginProviders } from "../plugin-sdk/provider-catalog-runtime.js";
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
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createCodexSupervisionToolsMcpServer } from "./codex-supervision-tools-serve.js";
import { createMcpConnection, failureOf, waitForStart } from "./tools-mcp.test-support.js";
import { createToolsMcpServer, serveRegisteredToolsMcpServer } from "./tools-stdio-server.js";

class NativeState {
  database?: DatabaseSync;
  disposals = 0;
  factories = 0;
  workspaceDir?: string;
  aborted = createDeferredCore();
  started = createDeferredCore();
  finish = createDeferredCore();
  abortReason?: unknown;
  abortFailure?: unknown;
  abortRead?: unknown;
  resolvePluginProviders = resolvePluginProviders;
}

let sequence = 0;
function nativePlugin(options: { failDisposal?: boolean; abortSdk?: boolean } = {}) {
  useNoBundledPlugins();
  const key = `__mcp_registration_native_${sequence++}`;
  const state = new NativeState();
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id: "mcp-native",
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: "mcp-native", register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const { resolvePluginProviders } = state;
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
  const plugins = { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } };
  return {
    state,
    acquire: () =>
      acquireStandalonePluginToolRegistry({
        context: { workspaceDir: plugin.dir, config: { plugins } },
      }),
    cleanup: () => {
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
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function causes(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(causes);
  }
  return error instanceof Error && error.cause !== undefined ? causes(error.cause) : [error];
}

function expectDisposed(state: NativeState) {
  expect(state).toMatchObject({ database: { isOpen: false }, disposals: 1 });
}

describe("MCP serving registration ownership", () => {
  it.each(["standalone", "borrowed"] as const)(
    "releases registrations and only its owned scheduler after validation fails (%s)",
    async (ownership) => {
      const { state, acquire, cleanup } = nativePlugin();
      let acquisition: Awaited<ReturnType<typeof acquire>> | undefined;
      const clock = createGatewaySchedulerClock(0);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const host = ownership === "borrowed" ? new LegacyPluginSdkResourceHost() : undefined;
      host?.bindScheduler(scheduler);
      const constructor = vi
        .spyOn(schedulerModule, "GatewayScheduler")
        .mockImplementation(function () {
          return scheduler;
        });
      const previouslyEnabled = areDiagnosticsEnabledForProcess();
      const heartbeats: string[] = [];
      const unsubscribe = onDiagnosticEvent((event) => {
        if (event.type === "diagnostic.heartbeat") {
          heartbeats.push(event.type);
        }
      });
      const serve = () =>
        serveRegisteredToolsMcpServer({
          acquireRegistry: async () => {
            startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
            logWebhookReceived({ channel: "test" });
            await clock.advanceBy(30_000);
            await waitForDiagnosticEventsDrained();
            expect(heartbeats).toHaveLength(1);
            return (acquisition = await acquire());
          },
          createServer: (tools) => createCodexSupervisionToolsMcpServer({ tools }),
        });
      try {
        setDiagnosticsEnabledForProcess(true);
        await expect(host ? host.run(serve) : serve()).rejects.toThrow(
          "Install or update @openclaw/codex",
        );
        expect(state.factories).toBe(1);
        expectDisposed(state);
        if (!acquisition) {
          throw new Error("Expected registry acquisition");
        }
        const released = acquisition;
        markPluginRegistryActive(released.registry);
        expect(() => released.resolveTools()).toThrow("Plugin tool registry has been released");
        expect(state.factories).toBe(1);
        expect(scheduler.signal.aborted).toBe(ownership === "standalone");
        expect(scheduler.nextWakeAtMs).toBe(
          ownership === "standalone" ? null : clock.clock.now() + 30_000,
        );
      } finally {
        stopDiagnosticHeartbeat();
        unsubscribe();
        await host?.close();
        await scheduler.stop();
        constructor.mockRestore();
        setDiagnosticsEnabledForProcess(previouslyEnabled);
        cleanup();
      }
    },
  );

  it("keeps peer cancellation SDK borrows with the admitted host under a foreign ambient host", async () => {
    const { state, acquire, cleanup } = nativePlugin({ abortSdk: true });
    const admittedHost = new LegacyPluginSdkResourceHost();
    const foreignHost = new LegacyPluginSdkResourceHost();
    const acquisition = await admittedHost.run(acquire);
    const server = withPluginRuntimeRegistryScope(acquisition.registry, () =>
      createToolsMcpServer({
        name: "native-peer-cancel",
        tools: admittedHost.run(acquisition.resolveTools),
        sdkResourceHost: admittedHost,
      }),
    );
    const { client, connect } = createMcpConnection(server);
    let call: Promise<unknown> | undefined;
    try {
      await connect();
      const controller = new AbortController();
      call = client
        .callTool({ name: "mcp_native_read" }, { signal: controller.signal })
        .catch((error: unknown) => error);
      await waitForStart(state.started.promise, call);
      // The peer shares the registry but owns a different SDK lifetime.
      foreignHost.run(() =>
        withPluginRuntimeRegistryScope(acquisition.registry, () =>
          controller.abort("peer cancellation reason"),
        ),
      );
      await state.aborted.promise;
      state.finish.resolve();
      await server.close();
      await call;
      expect(state).toMatchObject({ abortReason: "peer cancellation reason", abortRead: 42 });
      expect(state.abortFailure).toBeUndefined();
      await acquisition.release();
      await admittedHost.close();
      expectDisposed(state);
    } finally {
      state.finish.resolve();
      await server.close();
      await client.close();
      await call;
      await acquisition.release();
      await admittedHost.close();
      await foreignHost.close();
      cleanup();
    }
  });

  it.each(["self-close", "callback-error", "connect-error"] as const)(
    "joins owned stdio cleanup and preserves %s",
    async (mode) => {
      const connectError = mode === "connect-error";
      const { state, acquire, cleanup } = nativePlugin({ failDisposal: connectError });
      const [outbound, inbound] = InMemoryTransport.createLinkedPair();
      const callbackError = new Error("caller close callback failed");
      const onclose = vi.fn(() => {
        if (mode === "callback-error") {
          throw callbackError;
        }
      });
      if (connectError) {
        const close = inbound.close.bind(inbound);
        vi.spyOn(inbound, "close").mockImplementation(async () => {
          await close();
          throw new Error("synthetic transport close failure");
        });
      }
      let server: ReturnType<typeof createToolsMcpServer> | undefined;
      let connection: Promise<void> | undefined;
      let selfClose: Promise<unknown> | undefined;
      try {
        const failure = await failureOf(
          serveRegisteredToolsMcpServer({
            acquireRegistry: acquire,
            createServer(tools, sdkResourceHost) {
              const created = (server = createToolsMcpServer({
                name: "native-close",
                tools,
                sdkResourceHost,
              }));
              // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP exposes a callback property.
              created.onclose = onclose;
              if (connectError) {
                // The real SDK rejects the serving owner's second connection.
                connection = created.connect(inbound);
              } else {
                queueMicrotask(() => {
                  if (!created.transport) {
                    throw new Error("Expected the owned stdio transport");
                  }
                  selfClose = failureOf(created.transport.close());
                });
              }
              return created;
            },
          }),
        );
        await connection;
        if (connectError) {
          const failures = causes(failure);
          expect(failures).toHaveLength(3);
          expect(
            failures.map((error) => (error instanceof SdkError ? error.code : String(error))),
          ).toEqual(
            expect.arrayContaining([
              SdkErrorCode.AlreadyConnected,
              expect.stringContaining("synthetic transport close failure"),
              expect.stringContaining("synthetic registration disposal failure"),
            ]),
          );
        } else {
          const expected = mode === "callback-error" ? callbackError : undefined;
          expect(await selfClose).toBe(expected);
          expect(failure).toBe(expected);
        }
        expect(onclose).toHaveBeenCalledOnce();
        expect(server?.onclose).toBe(onclose);
        expectDisposed(state);
      } finally {
        await outbound.close();
        if (!connectError) {
          await selfClose;
          await server?.close();
        }
        cleanup();
      }
    },
  );
});

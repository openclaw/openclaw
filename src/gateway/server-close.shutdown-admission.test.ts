import { expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { startPluginServices } from "../plugins/services.js";
import { createServiceRegistration } from "../plugins/services.test-support.js";
import type { OpenClawPluginService } from "../plugins/types.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type {
  GatewayCloseParams as GatewayTeardownParams,
  GatewayClosePrepareParams,
} from "./server-close.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";

type TriggerInternalHookMock = (event: InternalHookEvent) => Promise<void>;

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  listChannelPlugins: vi.fn((): Array<{ id: "telegram" | "discord" }> => []),
  disposeAllCodeModeRuns: vi.fn(),
  disposeAgentHarnesses: vi.fn<() => Promise<void>>(async () => undefined),
  closeProviderTransportDispatcherPool: vi.fn(async () => undefined),
  disposeAllSessionMcpRuntimes: vi.fn<() => Promise<void>>(async () => undefined),
  triggerInternalHook: vi.fn<TriggerInternalHookMock>(async (_eventValue) => undefined),
  disposeAllBundleLspRuntimes: vi.fn<() => Promise<void>>(async () => undefined),
  drainRetainedEmbeddingProviders: vi.fn<() => Promise<void>>(async () => undefined),
  stopGmailWatcher: vi.fn(async () => undefined),
  disposeAcpSessionManagerInstance: vi.fn(async () => undefined),
  getAcpSessionManager: vi.fn(() => ({})),
  fenceSessionSuspensionWritesForGatewayShutdown: vi.fn(),
  closePluginStateDatabaseAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("../channels/plugins/index.js", async () => ({
  ...(await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  )),
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: mocks.stopGmailWatcher,
}));

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook: mocks.triggerInternalHook,
  };
});

vi.mock("../agents/harness/registry.js", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeAgentHarnesses,
}));

vi.mock("../agents/code-mode-state.js", () => ({
  disposeAllCodeModeRuns: mocks.disposeAllCodeModeRuns,
}));

vi.mock("../agents/provider-transport-dispatcher-pool.js", () => ({
  closeProviderTransportDispatcherPool: mocks.closeProviderTransportDispatcherPool,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-mcp-tools.js")>(
    "../agents/agent-bundle-mcp-tools.js",
  )),
  disposeAllSessionMcpRuntimes: mocks.disposeAllSessionMcpRuntimes,
}));

vi.mock("../agents/agent-bundle-lsp-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-lsp-runtime.js")>(
    "../agents/agent-bundle-lsp-runtime.js",
  )),
  disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
}));

vi.mock("./embeddings-provider-lifetime.js", () => ({
  drainRetainedOpenAiEmbeddingProviders: mocks.drainRetainedEmbeddingProviders,
}));

vi.mock("../agents/session-suspension.js", () => ({
  fenceSessionSuspensionWritesForGatewayShutdown:
    mocks.fenceSessionSuspensionWritesForGatewayShutdown,
}));

vi.mock("../acp/control-plane/manager.lifecycle.js", () => ({
  disposeAcpSessionManagerInstance: mocks.disposeAcpSessionManagerInstance,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: mocks.getAcpSessionManager,
}));

vi.mock("../plugin-state/plugin-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../plugin-state/plugin-state-store.js")>(
    "../plugin-state/plugin-state-store.js",
  )),
  closePluginStateDatabaseAsync: mocks.closePluginStateDatabaseAsync,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
  })),
}));

const { prepareGatewayClose, completeGatewayClose } = await import("./server-close.js");
const { createChatRunState } = await import("./server-chat-state.js");

type GatewayCloseParams = GatewayTeardownParams & GatewayClosePrepareParams;
type GatewayCloseClient = GatewayCloseParams["clients"] extends Set<infer T> ? T : never;

function createGatewayCloseHandler(params: GatewayCloseParams) {
  return async (opts?: GatewayCloseOptions) =>
    completeGatewayClose(params, await prepareGatewayClose(params, opts));
}

function createGatewayCloseTestDeps(
  overrides: Partial<GatewayCloseParams> = {},
): GatewayCloseParams {
  return {
    resolveGatewayContext: () => undefined,
    closePluginRegistry: async (onRetirement) => {
      let retirement: ReturnType<GatewayCloseParams["pluginMetadata"]["close"]> | undefined;
      const retire = () =>
        (retirement ??= clearActivePluginRegistry().then(() => ({
          cleanupCount: 0,
          failures: [],
        })));
      await onRetirement?.(retire);
      await retire();
      return { memoryErrors: [], pluginFailures: [] };
    },
    pluginMetadata: {
      beginClose() {},
      async close(onFinal, retireRegistry) {
        let retirement: ReturnType<GatewayCloseParams["pluginMetadata"]["close"]> | undefined;
        const retire = () =>
          (retirement ??= Promise.resolve()
            .then(retireRegistry)
            .then((result) => result ?? { cleanupCount: 0, failures: [] }));
        await onFinal?.(retire);
        return retire();
      },
    },
    bonjourStop: null,
    tailscaleCleanup: null,
    stopChannel: vi.fn(async () => undefined),
    pluginServices: null,
    disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
    drainRetainedOpenAiEmbeddingProviders: mocks.drainRetainedEmbeddingProviders,
    stopGmailWatcher: mocks.stopGmailWatcher,
    disposeAllCodeModeRuns: mocks.disposeAllCodeModeRuns,
    closeProviderTransportDispatcherPool: mocks.closeProviderTransportDispatcherPool,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() } as never,
    updateCheckStop: null,
    stopTaskRegistryMaintenance: null,
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    maintenance: {
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      startMediaCleanup: vi.fn(),
      stopMediaCleanup: vi.fn(async () => "drained" as const),
      stopSessionColdStorageMaintenance: vi.fn(async () => {}),
      stopTelemetryChecks: vi.fn(async () => {}),
      worktreeCleanup: setInterval(() => undefined, 60_000),
      skillUsageCleanup: vi.fn(),
    },
    stopMediaCleanup: vi.fn(async () => "drained" as const),
    agentUnsub: null,
    taskUnsub: null,
    heartbeatUnsub: null,
    transcriptUnsub: null,
    lifecycleUnsub: null,
    chatRunState: createChatRunState(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    restartRecoveryCandidates: new Map(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    nodeSendToSession: vi.fn(),
    getPendingReplyCount: vi.fn(() => 0),
    clients: new Set<GatewayCloseClient>(),
    configReloader: { stop: vi.fn(async () => undefined) },
    wss: {
      clients: new Set(),
      close: (cb: () => void) => cb(),
    } as never,
    httpServer: {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    } as never,
    ...overrides,
  } as GatewayCloseParams;
}

// Registered server.close, routed by vitest.gateway-server.config.ts to gateway-server.
it("keeps plugin service cleanup admitted after restart draining fences ordinary requests", async () => {
  const probeResults: boolean[] = [];
  const requestEntryLifetime = new GatewayRequestEntryLifetime();
  const enterAsExternalRequest = () =>
    requestEntryLifetime.enter({
      req: { method: "browser.request", params: {} },
      client: null,
      context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
    });
  const instance = new PluginInstance("shutdown-admission-probe");
  const service = instance.wrap<OpenClawPluginService>({
    id: "shutdown-admission-probe",
    start: async () => {},
    stop: async () => {
      // Real request-entry boundary: the close prelude already aborted the
      // entry lifetime, so this enter (and the nested router probe) succeeds
      // only while the chain owns the shutdown cleanup root — the same path a
      // Meet drain's browser.request/voicecall.end dispatch takes.
      enterAsExternalRequest().release();
      const nested = tryBeginGatewayRootWorkAdmission("ws:browser.request");
      probeResults.push(nested !== null);
      nested?.release();
    },
  });
  const registry = createEmptyPluginRegistry();
  registry.services.push(
    createServiceRegistration(service, {
      pluginId: "shutdown-admission-probe",
      origin: "bundled",
    }),
  );
  setActivePluginRegistry(registry);
  const pluginServices = await startPluginServices({ registry, config: {} });
  markGatewayRestartDraining("restart (SIGTERM)");
  // The real close prelude aborts request entry before prepare/complete close.
  requestEntryLifetime.beginClose();
  try {
    // Ordinary new roots stay fenced for the whole drain, and external
    // request entry stays closed.
    expect(tryBeginGatewayRootWorkAdmission("ws:browser.request")).toBeNull();
    expect(enterAsExternalRequest).toThrow("Gateway request entry is closed");
    const result = await createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        pluginServices,
        finishRequestEntries: () => requestEntryLifetime.sealAndJoin(),
      }),
    )({
      reason: "restart",
    });
    expect(result.warnings).toStrictEqual([]);
    expect(probeResults).toEqual([true]);
    // External requests stay fenced after cleanup as well.
    expect(enterAsExternalRequest).toThrow("Gateway request entry is closed");
  } finally {
    resetGatewayWorkAdmission();
    await pluginServices.stop().catch(() => {});
    await instance.dispose();
    await clearActivePluginRegistry();
  }
});

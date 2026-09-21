import { vi } from "vitest";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createChatRunState } from "./server-chat-state.js";
import type {
  GatewayCloseParams as GatewayTeardownParams,
  GatewayClosePrepareParams,
} from "./server-close.js";

type GatewayCloseParams = GatewayTeardownParams & GatewayClosePrepareParams;
type GatewayCloseFixtureMocks = Pick<
  GatewayCloseParams,
  | "disposeAllBundleLspRuntimes"
  | "stopGmailWatcher"
  | "disposeAllCodeModeRuns"
  | "closeProviderTransportDispatcherPool"
> & {
  drainRetainedEmbeddingProviders: GatewayCloseParams["drainRetainedOpenAiEmbeddingProviders"];
};
type GatewayCloseClient = GatewayCloseParams["clients"] extends Set<infer T> ? T : never;

export function createTestChatRunState() {
  const state = createChatRunState();
  const clear = state.clear;
  state.clear = vi.fn(() => clear());
  return state;
}

export function createGatewayCloseTestDepsFactory(mocks: GatewayCloseFixtureMocks) {
  return (overrides: Partial<GatewayCloseParams> = {}): GatewayCloseParams => {
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
        stopPeriodicTasks: vi.fn(async () => {}),
        startMediaCleanup: vi.fn(),
        stopMediaCleanup: vi.fn(async () => "drained" as const),
        skillUsageCleanup: vi.fn(async () => {}),
      },
      stopMediaCleanup: vi.fn(async () => "drained" as const),
      agentUnsub: null,
      taskUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: createTestChatRunState(),
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
    };
  };
}

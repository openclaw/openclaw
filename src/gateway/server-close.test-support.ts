import { vi } from "vitest";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createChatRunState } from "./server-chat-state.js";
import type {
  GatewayCloseParams as GatewayTeardownParams,
  GatewayClosePrepareParams,
} from "./server-close.js";
import type { GatewayCloseOptions } from "./server-public.js";

export type GatewayCloseParams = GatewayTeardownParams & GatewayClosePrepareParams;
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

/** Read the captured first close-effect call without changing its mock behavior. */
export function firstMockCall<T extends readonly unknown[]>(mock: {
  mock: { calls: readonly T[] };
}) {
  return mock.mock.calls[0];
}

export function createGatewayCloseTestHandlerFactory({
  prepareGatewayClose,
  completeGatewayClose,
}: Pick<typeof import("./server-close.js"), "prepareGatewayClose" | "completeGatewayClose">) {
  return (params: GatewayCloseParams) => async (opts?: GatewayCloseOptions) =>
    completeGatewayClose(params, await prepareGatewayClose(params, opts));
}

export function createTestChatRunState() {
  const state = createChatRunState();
  const clear = state.clear;
  state.clear = vi.fn(() => clear());
  return state;
}

export function createGatewayCloseTestDepsFactory(mocks: GatewayCloseFixtureMocks) {
  const resolveGatewayContext = () => undefined;
  return (overrides: Partial<GatewayCloseParams> = {}): GatewayCloseParams => {
    return {
      resolveGatewayContext,
      preparePluginRegistryClose: async () => [],
      drainWorktreeRunEnd: vi.fn(async () => {}),
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
      stopScheduler: vi.fn(async () => {}),
      disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
      drainRetainedOpenAiEmbeddingProviders: mocks.drainRetainedEmbeddingProviders,
      stopGmailWatcher: mocks.stopGmailWatcher,
      disposeAllCodeModeRuns: mocks.disposeAllCodeModeRuns,
      closeProviderTransportDispatcherPool: mocks.closeProviderTransportDispatcherPool,
      cron: { stop: vi.fn() },
      stopScheduledServices: vi.fn(async () => {}),
      updateCheckStop: null,
      maintenance: {
        stopPeriodicTasks: vi.fn(async () => {}),
        startMediaCleanup: vi.fn(),
        stopMediaCleanup: vi.fn(async () => "drained" as const),
        skillUsageCleanup: vi.fn(async () => {}),
      },
      stopMediaCleanup: vi.fn(async () => "drained" as const),
      agentUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: createTestChatRunState(),
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

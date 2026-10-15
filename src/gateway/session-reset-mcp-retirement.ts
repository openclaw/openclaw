import { logVerbose } from "../globals.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

type McpRunEndWatcherState = {
  cancellations: Map<string, () => void>;
  retirements: Set<Promise<void>>;
  watchers: Map<string, Promise<void>>;
};

const mcpRunEndWatcherState = resolveGlobalSingleton<McpRunEndWatcherState>(
  Symbol.for("openclaw.mcpRunEndWatchers"),
  () => ({ cancellations: new Map(), retirements: new Set(), watchers: new Map() }),
  async (state) => {
    for (const cancel of state.cancellations.values()) {
      cancel();
    }
    await Promise.allSettled([...state.watchers.values(), ...state.retirements]);
    state.cancellations.clear();
    state.retirements.clear();
    state.watchers.clear();
  },
);

export function watchSessionResetMcpRetirement(params: {
  sessionId: string;
  embeddedAgent: Pick<
    typeof import("../agents/embedded-agent-runner/runs.js"),
    "waitForEmbeddedAgentRunEnd" | "isEmbeddedAgentRunActive"
  >;
  retireMcpRuntime: (retainAcrossReuse: boolean) => Promise<void>;
  cleanupProviderResources: () => void;
}): { cancel: () => Promise<void> } {
  const { sessionId, embeddedAgent, retireMcpRuntime, cleanupProviderResources } = params;
  // Keep the real owner wait armed even when reset preserves its initiating reply.
  const watcher = getOrCreatePromise(
    mcpRunEndWatcherState.watchers,
    sessionId,
    async () => {
      let cancelWatcher = () => {};
      const cancelled = new Promise<false>((resolve) => {
        cancelWatcher = () => resolve(false);
      });
      mcpRunEndWatcherState.cancellations.set(sessionId, cancelWatcher);
      try {
        while (
          await Promise.race([embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, null), cancelled])
        ) {
          // A replacement can register after the wait promise settles but before
          // this continuation runs. Keep the required retirement armed for it.
          if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
            continue;
          }
          const retirement = retireMcpRuntime(false);
          mcpRunEndWatcherState.retirements.add(retirement);
          try {
            await retirement;
          } finally {
            mcpRunEndWatcherState.retirements.delete(retirement);
          }
          if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
            continue;
          }
          cleanupProviderResources();
          return;
        }
      } catch (error) {
        logVerbose(`sessions cleanup: failed to disarm deferred MCP retirement: ${String(error)}`);
      } finally {
        if (mcpRunEndWatcherState.cancellations.get(sessionId) === cancelWatcher) {
          mcpRunEndWatcherState.cancellations.delete(sessionId);
        }
      }
    },
    { evictOnSettled: true },
  );
  return {
    cancel: async () => {
      mcpRunEndWatcherState.cancellations.get(sessionId)?.();
      await watcher;
    },
  };
}

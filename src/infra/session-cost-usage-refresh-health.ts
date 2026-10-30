import {
  createCorePluginStateKeyedStore,
  type PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";

export type UsageCostRefreshFailure = {
  agentId: string;
  sessionFile: string;
  failedAt: number;
  reason: string;
};

/** Bounded health facts survive worker/process exits; successful refresh retires each fact. */
export function openUsageCostRefreshFailures(
  env?: NodeJS.ProcessEnv,
): Required<PluginStateKeyedStore<UsageCostRefreshFailure>> {
  return createCorePluginStateKeyedStore<UsageCostRefreshFailure>({
    ownerId: "core:usage-cost-cache",
    namespace: "refresh-failures",
    maxEntries: 256,
    env,
  });
}

import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import type { CronServiceState } from "./state.js";

export function collectSessionStorePathsForReaper(state: CronServiceState): string[] {
  const storePaths = new Set<string>();
  if (state.deps.resolveSessionStorePath) {
    const defaultAgentId = state.deps.defaultAgentId ?? DEFAULT_AGENT_ID;
    storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
    for (const job of state.store?.jobs ?? []) {
      const agentId =
        typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
      storePaths.add(state.deps.resolveSessionStorePath(agentId));
    }
  } else if (state.deps.sessionStorePath) {
    storePaths.add(state.deps.sessionStorePath);
  }
  return [...storePaths];
}

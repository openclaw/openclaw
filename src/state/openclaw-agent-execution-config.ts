import { listAgentIds } from "../agents/agent-roster.js";
import { resolveEffectiveAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { sessionChanges } from "../sessions/session-row-changes.js";

/** Retire captured physical routing when the committed roster or storage locator changes. */
export function watchAgentDatabaseExecutionConfig(
  agentId: string,
  env: NodeJS.ProcessEnv,
  retire: () => void,
): () => void {
  const config = getRuntimeConfigSnapshot();
  if (!config || !listAgentIds(config).includes(agentId)) {
    return () => {};
  }
  const agentDir = resolveEffectiveAgentDir(config, agentId, { env });
  const storePath = resolveSessionStorePathCore(config.session?.store, { agentId, env });
  return sessionChanges.subscribeFacts((change) => {
    if (!("all" in change) || change.scope !== "config") {
      return;
    }
    const current = getRuntimeConfigSnapshot();
    if (
      current &&
      (!listAgentIds(current).includes(agentId) ||
        resolveEffectiveAgentDir(current, agentId, { env }) !== agentDir ||
        resolveSessionStorePathCore(current.session?.store, { agentId, env }) !== storePath)
    ) {
      retire();
    }
  });
}

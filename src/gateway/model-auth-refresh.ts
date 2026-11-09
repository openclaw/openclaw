import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthLoginTarget } from "../agents/auth-profiles/shared-login-target.js";
import { prepareModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../secrets/runtime.js";
import { resolveModelAuthAgentScope } from "./server-methods/model-auth-agent-scope.js";
import { clearModelAuthStatusUsageCache } from "./server-methods/models-auth-status-usage-cache.js";

export async function refreshModelAuthStateAfterMutation(
  getRuntimeConfig: () => OpenClawConfig,
  agentId: string,
): Promise<void> {
  // The first CLI login can move the shared store after this Gateway pinned its owner.
  await reloadSharedAuthStoreOwnership();
  clearModelAuthStatusUsageCache();
  await refreshActiveProviderAuthRuntimeSnapshot();
  const config = getRuntimeConfig();
  const sharedTarget = resolveSharedMainAuthLoginTarget(config, agentId);
  if (sharedTarget) {
    // The shared owner is no longer a model agent. Join its configured consumers instead.
    await Promise.all(
      listAgentIds(config).map((id) =>
        prepareModelRuntimeSnapshot({
          config,
          agentId: id,
          agentDir: resolveAgentDir(config, id),
        }),
      ),
    );
    return;
  }
  const scope = resolveModelAuthAgentScope(config, agentId);
  if (!scope.ok) {
    throw new Error(scope.error.message);
  }
  // Persistence and secrets activation publish actual auth changes; join that generation.
  await prepareModelRuntimeSnapshot({ config, agentId, agentDir: scope.agentDir });
}

import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { noteRuntimeAuthProfileStorePersistedMutation } from "../agents/auth-profiles/runtime-snapshots.js";
import { prepareModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../secrets/runtime.js";
import {
  modelAuthAgentScopeError,
  resolveModelAuthAgentScope,
} from "./server-methods/model-auth-agent-scope.js";
import { clearModelAuthStatusUsageCache } from "./server-methods/models-auth-status-usage-cache.js";

export async function refreshModelAuthStateAfterMutation(
  getRuntimeConfig: () => OpenClawConfig,
  operation: "login" | "logout" | "update",
  agentId: string,
): Promise<void> {
  // The first CLI login can move the shared store after this Gateway pinned its owner.
  reloadSharedAuthStoreOwnership();
  clearModelAuthStatusUsageCache();
  await refreshActiveProviderAuthRuntimeSnapshot();
  const config = getRuntimeConfig();
  const scope = resolveModelAuthAgentScope(config, agentId);
  if (!scope.ok) {
    throw new Error(modelAuthAgentScopeError(scope).message);
  }
  // The publication owner coalesces this with in-process credential writes.
  noteRuntimeAuthProfileStorePersistedMutation(scope.agentDir, {
    credentialsChanged: true,
    profileSetChanged: operation !== "update",
    stateChanged: false,
    profileIds: [],
  });
  await prepareModelRuntimeSnapshot({ config, agentId, agentDir: scope.agentDir });
}

import { resolveAgentDir } from "../../agents/agent-scope.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";

/**
 * Prepare the selected agent's account-owned SecretRefs for one standalone local
 * capability run. Every agent-scoped local runner calls this before provider auth.
 */
export async function prepareLocalCapabilityAccountSecrets(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  if (getActiveSecretsRuntimeConfigSnapshot()) {
    return;
  }

  const secretsRuntime = await import("../../secrets/runtime.js");
  const snapshot = await secretsRuntime.prepareSecretsRuntimeSnapshot({
    config: getRuntimeConfigSourceSnapshot() ?? params.cfg,
    assignmentConfig: params.cfg,
    agentDirs: [resolveAgentDir(params.cfg, params.agentId)],
    includeConfigRefs: false,
    allowUnavailableSecretOwners: true,
  });
  secretsRuntime.activateSecretsRuntimeSnapshot(snapshot);
}

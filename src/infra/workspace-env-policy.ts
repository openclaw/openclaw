import { normalizeEnvVarKey } from "./host-env-security.js";

const BLOCKED_WORKSPACE_OPENCLAW_ENV_KEYS = new Set([
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_BUNDLED_HOOKS_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_BUNDLED_SKILLS_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_OAUTH_DIR",
  "OPENCLAW_STATE_DIR",
  "PI_CODING_AGENT_DIR",
]);

export function isBlockedWorkspaceOpenClawEnvVar(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return false;
  }
  return BLOCKED_WORKSPACE_OPENCLAW_ENV_KEYS.has(key.toUpperCase());
}

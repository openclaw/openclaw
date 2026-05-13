import path from "node:path";
import { resolveAuthProfileStoreAgentDir } from "../../../agents/auth-profiles/paths.js";

export const LEGACY_AUTH_PROFILE_FILENAME = "auth-profiles.json";
export const LEGACY_AUTH_STATE_FILENAME = "auth-state.json";

export function resolveLegacyAuthProfilePath(agentDir?: string): string {
  return path.join(resolveAuthProfileStoreAgentDir(agentDir), LEGACY_AUTH_PROFILE_FILENAME);
}

export function resolveLegacyAuthProfileStatePath(agentDir?: string): string {
  return path.join(resolveAuthProfileStoreAgentDir(agentDir), LEGACY_AUTH_STATE_FILENAME);
}

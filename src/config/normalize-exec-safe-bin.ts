import { listAgentEntries } from "../agents/agent-scope-config.js";
/**
 * Config normalization for exec safe-bin policy before materialized config is consumed.
 * Keep this limited to persisted global/per-agent config shape; runtime trust decisions live in infra.
 */
import { normalizeSafeBinProfileFixtures } from "../infra/exec-safe-bin-policy.js";
import { normalizeTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
import type { OpenClawConfig } from "./types.js";
import type { ExecToolConfig } from "./types.tools.js";

/** Normalize exec safe-bin profiles and trusted dirs in global and per-agent config scopes. */
export function normalizeExecSafeBinProfilesInConfig(cfg: OpenClawConfig): void {
  const normalizeExec = (exec: ExecToolConfig | undefined) => {
    if (!exec || typeof exec !== "object" || Array.isArray(exec)) {
      return;
    }
    const normalizedProfiles = normalizeSafeBinProfileFixtures(exec.safeBinProfiles);
    exec.safeBinProfiles =
      Object.keys(normalizedProfiles).length > 0 ? normalizedProfiles : undefined;
    const normalizedTrustedDirs = normalizeTrustedSafeBinDirs(exec.safeBinTrustedDirs);
    exec.safeBinTrustedDirs = normalizedTrustedDirs.length > 0 ? normalizedTrustedDirs : undefined;
  };

  // Safe-bin config can be set globally or overridden per agent; normalize both persisted scopes.
  normalizeExec(cfg.tools?.exec);
  for (const agent of listAgentEntries(cfg)) {
    normalizeExec(agent?.tools?.exec);
  }
}

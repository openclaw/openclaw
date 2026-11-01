import os from "node:os";
import path from "node:path";
import { normalizeProfileName, resolveProfileStateDir } from "../cli/profile-utils.js";
import { resolveStateDir } from "../config/state-dir.js";

/** The only released migrations allowed to look outside the active state directory. */
export function resolveLegacyProfileMigrationExceptions(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configuredAgentDir?: string;
}): { profileWorkspace?: string; standaloneAgent?: string } {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  // Validate before constructing the legacy workspace path, including env-only profiles.
  const profileStateDir = resolveProfileStateDir(
    env.OPENCLAW_PROFILE?.trim() || "default",
    env,
    homedir,
  );
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  const legacyStateDir = resolveProfileStateDir("default", {}, homedir);
  const standaloneAgent = path.join(legacyStateDir, "agent");
  const ownsStandaloneAgent =
    (!profile && path.resolve(resolveStateDir(env, homedir)) === path.resolve(legacyStateDir)) ||
    (params.configuredAgentDir !== undefined &&
      path.resolve(params.configuredAgentDir) === path.resolve(standaloneAgent));
  return {
    // A profile may migrate only its own old workspace, never enumerate sibling profiles.
    ...(profile
      ? {
          profileWorkspace: path.join(
            path.dirname(profileStateDir),
            ".openclaw",
            `workspace-${profile}`,
          ),
        }
      : {}),
    // The unscoped SDK layout belongs to the default install unless explicitly selected.
    ...(ownsStandaloneAgent ? { standaloneAgent } : {}),
  };
}

// Bootstrap policy is bundled separately so executable selection never loads runtime state.
import path from "node:path";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import { resolveStateDir } from "../config/state-dir.js";
import { loadGlobalRuntimeDotEnvFilesCore } from "../infra/dotenv-global-core.js";

export { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
export { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export function resolveNodeHostLauncherStateDir(
  argv: string[],
  inheritedEnv: NodeJS.ProcessEnv,
): string | null {
  const parsed = parseCliProfileArgs(argv);
  if (!parsed.ok) {
    return null;
  }
  const env = { ...inheritedEnv };
  if (parsed.profile) {
    applyCliProfileEnv({ profile: parsed.profile, env });
  }
  // Workspace dotenv cannot set OPENCLAW_* selectors. Snapshot global paths once,
  // and leave the actual child's environment loading and precedence unchanged.
  loadGlobalRuntimeDotEnvFilesCore({
    env,
    stateEnvPath: path.join(resolveStateDir(env), ".env"),
    quiet: true,
    onWarning: (message) => process.stderr.write(`openclaw: ${message}\n`),
  });
  return resolveStateDir(env);
}

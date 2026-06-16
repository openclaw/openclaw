// CLI dotenv loader that preserves workspace overrides before global runtime fallbacks.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";

/** Load `.env` files for normal CLI commands without overriding existing process env. */
export function loadCliDotEnv(opts?: { loadGlobalEnv?: boolean; quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  // When cwd has been deleted, skip workspace .env — it cannot exist.
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
  } catch {
    // cwd deleted; workspace .env cannot exist, skip it.
  }
  if (cwd) {
    const cwdEnvPath = path.join(cwd, ".env");
    loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });
  }

  if (opts?.loadGlobalEnv === false) {
    return;
  }
  // Then load the global fallback set without overriding any env vars that
  // were already set or loaded from CWD. This includes the Ubuntu fresh-install
  // gateway.env compatibility path.
  loadGlobalRuntimeDotEnvFiles({
    quiet,
    stateEnvPath: path.join(resolveStateDir(process.env), ".env"),
  });
}

import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";
import { safeCwd } from "../infra/home-dir.js";

export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const cwd = safeCwd();
  if (cwd != null) {
    loadWorkspaceDotEnvFile(path.join(cwd, ".env"), { quiet });
  }

  // Then load the global fallback set without overriding any env vars that
  // were already set or loaded from CWD. This includes the Ubuntu fresh-install
  // gateway.env compatibility path.
  loadGlobalRuntimeDotEnvFiles({
    quiet,
    stateEnvPath: path.join(resolveStateDir(process.env), ".env"),
  });
}

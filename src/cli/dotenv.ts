import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";
import { safeProcessCwd } from "./utils/cwd.js";

export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const cwdEnvPath = path.join(safeProcessCwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load the global fallback set without overriding any env vars that
  // were already set or loaded from CWD. This includes the Ubuntu fresh-install
  // gateway.env compatibility path.
  loadGlobalRuntimeDotEnvFiles({
    quiet,
    stateEnvPath: path.join(resolveStateDir(process.env), ".env"),
  });
}

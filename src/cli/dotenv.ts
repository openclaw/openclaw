import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadRuntimeDotEnvFile, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";

export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load the global fallback from the active state dir without overriding
  // any env vars that were already set or loaded from CWD.
  const globalEnvPath = path.join(resolveStateDir(process.env), ".env");
  loadRuntimeDotEnvFile(globalEnvPath, { quiet });
}

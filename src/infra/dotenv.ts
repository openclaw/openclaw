import path from "node:path";
import { resolveConfigDir } from "../utils.js";
import { loadRuntimeDotEnvFile, loadWorkspaceDotEnvFile } from "./dotenv-loader.js";

export function loadDotEnv(_opts?: { quiet?: boolean }) {
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath);

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  loadRuntimeDotEnvFile(globalEnvPath);
}

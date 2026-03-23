import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveStateDir } from "../config/paths.js";

export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load the global fallback from the active state dir without overriding
  // any env vars that were already set or loaded from CWD.
  const globalEnvPath = path.join(resolveStateDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}

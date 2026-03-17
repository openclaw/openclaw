import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

export function loadDotEnv(opts?: { quiet?: boolean; env?: NodeJS.ProcessEnv }) {
  const quiet = opts?.quiet ?? true;
  const env = opts?.env ?? process.env;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet, processEnv: env });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    // Continue and still allow per-worktree local overrides.
  } else {
    dotenv.config({ quiet, path: globalEnvPath, override: false, processEnv: env });
  }

  // Finally load per-worktree local overrides when present.
  // This file is intentionally gitignored and wins over .env/global fallback.
  const localEnvPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ quiet, path: localEnvPath, override: true, processEnv: env });
  }
}

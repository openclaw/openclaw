import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";
import { mergePathPrepend } from "./path-prepend.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  // Parse .env PATH before dotenv.config so we can merge it manually.
  // dotenv's override:false silently drops PATH because it's always pre-set,
  // but users expect .env PATH entries to be prepended to the existing PATH.
  const raw = fs.readFileSync(globalEnvPath, "utf8");
  const parsed = dotenv.parse(raw);
  const dotenvPath = parsed.PATH?.trim();

  dotenv.config({ quiet, path: globalEnvPath, override: false });

  // Merge .env PATH entries into process.env.PATH (prepend, deduped).
  if (dotenvPath) {
    const entries = dotenvPath.split(path.delimiter).filter(Boolean);
    if (entries.length > 0) {
      process.env.PATH = mergePathPrepend(process.env.PATH, entries);
    }
  }
}

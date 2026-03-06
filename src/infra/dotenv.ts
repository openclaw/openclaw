import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g;

function expandEnvReferences(
  parsed: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const resolving = new Set<string>();

  const resolveValue = (key: string): string | undefined => {
    const existing = baseEnv[key];
    if (existing !== undefined) {
      return existing;
    }
    if (Object.hasOwn(resolved, key)) {
      return resolved[key];
    }
    const raw = parsed[key];
    if (raw === undefined) {
      return undefined;
    }
    if (resolving.has(key)) {
      return "";
    }

    resolving.add(key);
    const expanded = raw.replace(ENV_REFERENCE_PATTERN, (_, braced, bare) => {
      const name = typeof braced === "string" && braced.length > 0 ? braced : bare;
      return resolveValue(name) ?? "";
    });
    resolving.delete(key);
    resolved[key] = expanded;
    return expanded;
  };

  for (const key of Object.keys(parsed)) {
    resolveValue(key);
  }
  return resolved;
}

function loadEnvFile(filePath: string, opts?: { override?: boolean }) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const parsed = dotenv.parse(fs.readFileSync(filePath, "utf8"));
  const expanded = expandEnvReferences(parsed, process.env);
  dotenv.populate(process.env, expanded, { override: opts?.override ?? false });
}

export function loadDotEnv(_opts?: { quiet?: boolean }) {
  // Load from process CWD first so fallback expansion can reference it.
  loadEnvFile(path.join(process.cwd(), ".env"));

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  loadEnvFile(globalEnvPath, { override: false });
}

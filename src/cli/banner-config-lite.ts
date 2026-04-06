import fs from "node:fs";
import JSON5 from "json5";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { applyConfigEnvVars } from "../config/env-vars.js";
import { resolveConfigIncludes } from "../config/includes.js";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadDotEnv } from "../infra/dotenv.js";
import type { TaglineMode } from "./tagline.js";

function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

type BannerConfigShape = {
  cli?: { banner?: { taglineMode?: unknown } };
};

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    const configPath = resolveConfigPath(env);
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    // Keep banner startup cheap: only read the raw config path and resolve includes.
    const parsed = resolveConfigIncludes(
      JSON5.parse(fs.readFileSync(configPath, "utf-8")),
      configPath,
    ) as BannerConfigShape;
    // Keep banner startup cheap, but still honor config.env and ${VAR} substitution.
    if (parsed && typeof parsed === "object" && "env" in parsed) {
      applyConfigEnvVars(parsed as OpenClawConfig, env);
    }
    if (env === process.env) {
      loadDotEnv({ quiet: true });
    }
    const resolved = resolveConfigEnvVars(parsed, env, {
      onMissing: () => {
        // Match the full config loader by tolerating unrelated missing env vars.
      },
    }) as BannerConfigShape;
    return parseTaglineMode(resolved.cli?.banner?.taglineMode);
  } catch {
    return undefined;
  }
}

import fs from "node:fs";
import JSON5 from "json5";
import { resolveConfigIncludes } from "../config/includes.js";
import { resolveConfigPathCandidate } from "../config/paths.js";
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
    const configPath = resolveConfigPathCandidate(env);
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    // Keep banner startup cheap: only read the raw config path and resolve includes.
    const parsed = resolveConfigIncludes(
      JSON5.parse(fs.readFileSync(configPath, "utf-8")),
      configPath,
    ) as BannerConfigShape;
    return parseTaglineMode(parsed.cli?.banner?.taglineMode);
  } catch {
    return undefined;
  }
}

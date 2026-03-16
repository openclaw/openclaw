import fs from "node:fs";
import JSON5 from "json5";
import { resolveConfigPath } from "../config/paths.js";
import type { TaglineMode } from "./tagline.js";

function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    const configPath = resolveConfigPath(env);
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed: { cli?: { banner?: { taglineMode?: unknown } } } = JSON5.parse(raw);
    return parseTaglineMode(parsed.cli?.banner?.taglineMode);
  } catch {
    return undefined;
  }
}

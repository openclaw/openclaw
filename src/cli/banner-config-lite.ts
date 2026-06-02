import { createConfigIO } from "../config/config.js";
import type { TaglineMode } from "./tagline.js";

/** Parse the banner tagline mode without loading the full banner renderer. */
export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

/** Read banner tagline mode from config, returning undefined when config is unavailable. */
export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    const parsed = createConfigIO({ env }).loadConfig() as {
      cli?: { banner?: { taglineMode?: unknown } };
    };
    return parseTaglineMode(parsed.cli?.banner?.taglineMode);
  } catch {
    return undefined;
  }
}

import json5 from "json5";
import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.js";
import { resolveConfigPath } from "../config/paths.js";

type LoggingConfig = OpenClawConfig["logging"];

export function readLoggingConfig(): LoggingConfig | undefined {
  const configPath = resolveConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = json5.parse(raw);
    const logging = parsed?.logging;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  }
}

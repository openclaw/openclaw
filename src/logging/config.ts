import { getCommandPathWithRootOptions } from "../cli/argv.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import JSON5 from "json5";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import fs from "node:fs";
import os from "node:os";

type LoggingConfig = OpenClawConfig["logging"];

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead()) {
    return undefined;
  }
  try {
    const configPath = resolveConfigPath(process.env, resolveStateDir(process.env, os.homedir));
    if (!configPath || !fs.existsSync(configPath)) {
      return undefined;
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON5.parse(raw) as OpenClawConfig;
    const logging = parsed?.logging as unknown;
    if (!logging || typeof logging !== "object" || Array.isArray(logging)) {
      return undefined;
    }
    return logging as LoggingConfig;
  } catch {
    return undefined;
  }
}

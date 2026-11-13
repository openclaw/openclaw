import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureEnvironmentKey } from "../shared/environment-key.js";
import type { PluginRuntimeLoadContext } from "./runtime/load-context.js";

export function createToolLoadContext(
  config: OpenClawConfig,
  workspaceDir: string,
  overrides: Partial<PluginRuntimeLoadContext> = {},
): PluginRuntimeLoadContext {
  return {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir,
    env: process.env,
    environmentKey: captureEnvironmentKey(overrides.env),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

export function readToolTestEvents<T>(file: string): T[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line): T => JSON.parse(line))
    : [];
}

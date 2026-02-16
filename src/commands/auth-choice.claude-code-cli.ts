import { spawnSync } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";

export const CLAUDE_CODE_CLI_DEFAULT_MODEL = "claude-cli/opus-4.6";

export function resolveClaudeCodeCliCommandPath(): string | undefined {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["claude"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return undefined;
  }

  const firstMatch = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstMatch || undefined;
}

export function applyClaudeCodeCliProviderConfig(
  config: OpenClawConfig,
  options?: { commandPath?: string },
): OpenClawConfig {
  const commandPath = options?.commandPath?.trim();

  // We only materialize a config entry when we have a resolved absolute path.
  // Otherwise OpenClaw uses the built-in `claude-cli` backend defaults.
  if (!commandPath) {
    return config;
  }

  const existingEntry = config.agents?.defaults?.cliBackends?.["claude-cli"] ?? {};

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        cliBackends: {
          ...config.agents?.defaults?.cliBackends,
          "claude-cli": {
            ...existingEntry,
            command: commandPath,
          },
        },
      },
    },
  };
}

export function applyClaudeCodeCliDefaultConfig(
  config: OpenClawConfig,
  options?: {
    commandPath?: string;
    defaultModel?: string;
  },
): OpenClawConfig {
  const defaultModel = options?.defaultModel ?? CLAUDE_CODE_CLI_DEFAULT_MODEL;
  const withProvider = applyClaudeCodeCliProviderConfig(config, {
    commandPath: options?.commandPath,
  });
  const withAllowlist = ensureModelAllowlistEntry({
    cfg: withProvider,
    modelRef: defaultModel,
  });
  const existingModel = withAllowlist.agents?.defaults?.model;

  return {
    ...withAllowlist,
    agents: {
      ...withAllowlist.agents,
      defaults: {
        ...withAllowlist.agents?.defaults,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: existingModel.fallbacks }
            : {}),
          primary: defaultModel,
        },
      },
    },
  };
}

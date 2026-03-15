import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { registerExtensionHostCliCommands } from "../extension-host/cli-lifecycle.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

export function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
) {
  const config = cfg ?? loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const logger: PluginLogger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
  };
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir,
    env,
    logger,
  });
  registerExtensionHostCliCommands({
    program,
    registry,
    config,
    workspaceDir,
    logger,
  });
}

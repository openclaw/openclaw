import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";
import type { PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

function loadPluginCliRegistry(cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const config = cfg ?? loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const logger: PluginLogger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
  };
  return {
    config,
    workspaceDir,
    logger,
    registry: loadOpenClawPlugins({
      config,
      workspaceDir,
      env,
      logger,
    }),
  };
}

export function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): OpenClawPluginCliCommandDescriptor[] {
  try {
    const { registry } = loadPluginCliRegistry(cfg, env);
    const seen = new Set<string>();
    const descriptors: OpenClawPluginCliCommandDescriptor[] = [];
    for (const entry of registry.cliRegistrars) {
      for (const descriptor of entry.descriptors) {
        if (seen.has(descriptor.name)) {
          continue;
        }
        seen.add(descriptor.name);
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  } catch {
    return [];
  }
}

export function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
) {
  const { config, workspaceDir, logger, registry } = loadPluginCliRegistry(cfg, env);

  const existingCommands = new Set(program.commands.map((cmd) => cmd.name()));

  for (const entry of registry.cliRegistrars) {
    if (entry.commands.length > 0) {
      const overlaps = entry.commands.filter((command) => existingCommands.has(command));
      if (overlaps.length > 0) {
        log.debug(
          `plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(
            ", ",
          )})`,
        );
        continue;
      }
    }
    try {
      const result = entry.register({
        program,
        config,
        workspaceDir,
        logger,
      });
      if (result && typeof result.then === "function") {
        void result.catch((err) => {
          log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
        });
      }
      for (const command of entry.commands) {
        existingCommands.add(command);
      }
    } catch (err) {
      log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
    }
  }
}

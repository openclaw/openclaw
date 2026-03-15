import type { Command } from "commander";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginLogger } from "../plugins/types.js";

export function registerExtensionHostCliCommands(params: {
  program: Command;
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir: string;
  logger: PluginLogger;
}): void {
  const existingCommands = new Set(params.program.commands.map((cmd) => cmd.name()));

  for (const entry of params.registry.cliRegistrars) {
    if (entry.commands.length > 0) {
      const overlaps = entry.commands.filter((command) => existingCommands.has(command));
      if (overlaps.length > 0) {
        params.logger.debug(
          `plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(
            ", ",
          )})`,
        );
        continue;
      }
    }
    try {
      const result = entry.register({
        program: params.program,
        config: params.config,
        workspaceDir: params.workspaceDir,
        logger: params.logger,
      });
      if (result && typeof result.then === "function") {
        void result.catch((err) => {
          params.logger.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
        });
      }
      for (const command of entry.commands) {
        existingCommands.add(command);
      }
    } catch (err) {
      params.logger.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
    }
  }
}

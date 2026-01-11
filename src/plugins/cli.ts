import type { Command } from "commander";

import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging.js";
import { loadClawdbotPlugins } from "./loader.js";
import type { PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

export function registerPluginCliCommands(
  program: Command,
  cfg?: ClawdbotConfig,
) {
  const config = cfg ?? loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(
    config,
    resolveDefaultAgentId(config),
  );
  const logger: PluginLogger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
  };
  const registry = loadClawdbotPlugins({
    config,
    workspaceDir,
    logger,
  });

  for (const entry of registry.cliRegistrars) {
    try {
      const result = entry.register({
        program,
        config,
        workspaceDir,
        logger,
      });
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((err) => {
          log.warn(
            `plugin CLI register failed (${entry.pluginId}): ${String(err)}`,
          );
        });
      }
    } catch (err) {
      log.warn(
        `plugin CLI register failed (${entry.pluginId}): ${String(err)}`,
      );
    }
  }
}

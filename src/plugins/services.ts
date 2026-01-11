import type { ClawdbotConfig } from "../config/config.js";
import { STATE_DIR_CLAWDBOT } from "../config/paths.js";
import { createSubsystemLogger } from "../logging.js";
import type { PluginRegistry } from "./registry.js";

const log = createSubsystemLogger("plugins");

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: ClawdbotConfig;
  workspaceDir?: string;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];

  for (const entry of params.registry.services) {
    const service = entry.service;
    try {
      await service.start({
        config: params.config,
        workspaceDir: params.workspaceDir,
        stateDir: STATE_DIR_CLAWDBOT,
        logger: {
          info: (msg) => log.info(msg),
          warn: (msg) => log.warn(msg),
          error: (msg) => log.error(msg),
          debug: (msg) => log.debug(msg),
        },
      });
      running.push({
        id: service.id,
        stop: service.stop
          ? () =>
              service.stop?.({
                config: params.config,
                workspaceDir: params.workspaceDir,
                stateDir: STATE_DIR_CLAWDBOT,
                logger: {
                  info: (msg) => log.info(msg),
                  warn: (msg) => log.warn(msg),
                  error: (msg) => log.error(msg),
                  debug: (msg) => log.debug(msg),
                },
              })
          : undefined,
      });
    } catch (err) {
      log.error(`plugin service failed (${service.id}): ${String(err)}`);
    }
  }

  return {
    stop: async () => {
      for (const entry of running.reverse()) {
        if (!entry.stop) continue;
        try {
          await entry.stop();
        } catch (err) {
          log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
        }
      }
    },
  };
}

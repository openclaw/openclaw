import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeLogging(): PluginRuntime["logging"] {
  return {
    shouldLogVerbose,
    getChildLogger: (bindings, opts) => {
      const logger = getChildLogger(bindings, {
        level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
      });
      return {
        debug: (message, meta) => logger.debug?.(message, meta),
        info: (message, meta) => logger.info(message, meta),
        warn: (message, meta) => logger.warn(message, meta),
        error: (message, meta) => logger.error(message, meta),
      };
    },
  };
}

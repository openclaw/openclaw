import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import type { PluginRuntime } from "./types.js";

function hasStructuredMeta(
  meta: Record<string, unknown> | undefined,
): meta is Record<string, unknown> {
  return Boolean(meta && Object.keys(meta).length > 0);
}

function writeRuntimeLog(params: {
  message: string;
  meta: Record<string, unknown> | undefined;
  writeMessage: (message: string) => void;
  writeMeta: (meta: Record<string, unknown>, message: string) => void;
}): void {
  if (hasStructuredMeta(params.meta)) {
    params.writeMeta(params.meta, params.message);
    return;
  }
  params.writeMessage(params.message);
}

export function createRuntimeLogging(): PluginRuntime["logging"] {
  return {
    shouldLogVerbose,
    getChildLogger: (bindings, opts) => {
      const logger = getChildLogger(bindings, {
        level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
      });
      return {
        debug: (message, meta) =>
          writeRuntimeLog({
            message,
            meta,
            writeMessage: (m) => logger.debug?.(m),
            writeMeta: (m, text) => logger.debug?.(m, text),
          }),
        info: (message, meta) =>
          writeRuntimeLog({
            message,
            meta,
            writeMessage: (m) => logger.info(m),
            writeMeta: (m, text) => logger.info(m, text),
          }),
        warn: (message, meta) =>
          writeRuntimeLog({
            message,
            meta,
            writeMessage: (m) => logger.warn(m),
            writeMeta: (m, text) => logger.warn(m, text),
          }),
        error: (message, meta) =>
          writeRuntimeLog({
            message,
            meta,
            writeMessage: (m) => logger.error(m),
            writeMeta: (m, text) => logger.error(m, text),
          }),
      };
    },
  };
}

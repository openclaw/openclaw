// Builds plugin-scoped loggers for runtime and setup code.
import type { PluginLogger } from "./types.js";

type LoggerLike = {
  info: PluginLogger["info"];
  warn: PluginLogger["warn"];
  error: PluginLogger["error"];
  debug?: PluginLogger["debug"];
};

function forwardPluginLog(
  log: PluginLogger["info"] | undefined,
  msg: string,
  meta?: Record<string, unknown>,
  semantics?: import("./logging-types.js").PluginLogSemantics,
): void {
  if (!log) {
    return;
  }
  if (semantics !== undefined) {
    log(msg, meta, semantics);
    return;
  }
  if (meta !== undefined) {
    log(msg, meta);
    return;
  }
  log(msg);
}

/** Adapts a generic logger to the plugin loader logger interface. */
export function createPluginLoaderLogger(logger: LoggerLike): PluginLogger {
  return {
    info: (msg, meta, semantics) => forwardPluginLog(logger.info, msg, meta, semantics),
    warn: (msg, meta, semantics) => forwardPluginLog(logger.warn, msg, meta, semantics),
    error: (msg, meta, semantics) => forwardPluginLog(logger.error, msg, meta, semantics),
    debug: (msg, meta, semantics) => forwardPluginLog(logger.debug, msg, meta, semantics),
  };
}

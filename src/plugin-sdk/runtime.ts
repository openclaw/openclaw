import { format } from "node:util";
import type { RuntimeEnv } from "../runtime.js";
export type { RuntimeEnv } from "../runtime.js";
export { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
export {
  danger,
  info,
  isVerbose,
  isYes,
  logVerbose,
  logVerboseConsole,
  setVerbose,
  setYes,
  shouldLogVerbose,
  success,
  warn,
} from "../globals.js";
export * from "../logging.js";
export { waitForAbortSignal } from "../infra/abort-signal.js";
export { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";

type LoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};

/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
export function createLoggerBackedRuntime(params: {
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv {
  return {
    log: (...args) => {
      params.logger.info(format(...args));
    },
    error: (...args) => {
      params.logger.error(format(...args));
    },
    exit: (code: number): never => {
      throw params.exitError?.(code) ?? new Error(`exit ${code}`);
    },
  };
}

/** Reuse an existing runtime when present, otherwise synthesize one from the provided logger. */
export function resolveRuntimeEnv(params: {
  runtime?: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv {
  return params.runtime ?? createLoggerBackedRuntime(params);
}

/** Resolve a runtime that treats exit requests as unsupported errors instead of process termination. */
export function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime?: RuntimeEnv;
  logger: LoggerLike;
  unavailableMessage?: string;
}): RuntimeEnv {
  return resolveRuntimeEnv({
    runtime: params.runtime,
    logger: params.logger,
    exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available"),
  });
}

import { format } from "node:util";
import type { RuntimeEnv } from "../runtime.js";

type LoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};

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

export function resolveRuntimeEnv(params: {
  runtime?: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv {
  return params.runtime ?? createLoggerBackedRuntime(params);
}

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

import { format } from "node:util";
import type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
export type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
export { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
export { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
export { getChannelsCommandSecretTargetIds } from "../cli/command-secret-targets.js";
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
export { createBackupArchive } from "../infra/backup-create.js";
export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
export { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
export { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
export { removePluginFromConfig } from "../plugins/uninstall.js";

/** Minimal logger contract accepted by runtime-adapter helpers. */
type LoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};

/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
export function createLoggerBackedRuntime(params: {
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv {
  return {
    log: (...args) => {
      params.logger.info(format(...args));
    },
    error: (...args) => {
      params.logger.error(format(...args));
    },
    writeStdout: (value) => {
      params.logger.info(value);
    },
    writeJson: (value, space = 2) => {
      params.logger.info(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
    exit: (code: number): never => {
      throw params.exitError?.(code) ?? new Error(`exit ${code}`);
    },
  };
}

/** Reuse an existing runtime when present, otherwise synthesize one from the provided logger. */
export function resolveRuntimeEnv(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv;
export function resolveRuntimeEnv(params: {
  runtime?: undefined;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
export function resolveRuntimeEnv(params: {
  runtime?: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv | OutputRuntimeEnv {
  return params.runtime ?? createLoggerBackedRuntime(params);
}

/** Resolve a runtime that treats exit requests as unsupported errors instead of process termination. */
export function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  unavailableMessage?: string;
}): RuntimeEnv;
export function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime?: undefined;
  logger: LoggerLike;
  unavailableMessage?: string;
}): OutputRuntimeEnv;
export function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime?: RuntimeEnv;
  logger: LoggerLike;
  unavailableMessage?: string;
}): RuntimeEnv | OutputRuntimeEnv {
  if (params.runtime) {
    return resolveRuntimeEnv({
      runtime: params.runtime,
      logger: params.logger,
      exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available"),
    });
  }
  return resolveRuntimeEnv({
    logger: params.logger,
    exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available"),
  });
}

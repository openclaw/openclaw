import { logInfo, logWarn } from "../logger.js";

export const silentRuntime = {
  log: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
  exit: (code: number): never => {
    throw new Error(`embedded tui runtime exit ${String(code)}`);
  },
};

export const embeddedSessionStartupMigrationLog = {
  info: (message: string) => logInfo(message, silentRuntime),
  warn: (message: string) => logWarn(message, silentRuntime),
};

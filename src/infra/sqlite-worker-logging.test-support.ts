import { setLoggerOverride } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";

export type LoggingOperations = { echo: { input: string; output: { value: string } } };

// The fixture exercises worker messaging and logging without native database work.
export function createSqliteWorkerBackend(input: {
  logFile: string;
}): SqliteWorkerBackend<LoggingOperations> {
  setLoggerOverride({ file: input.logFile, consoleStyle: "compact" });
  const log = createSubsystemLogger("state/sqlite");
  log.debug("worker fixture open");
  return {
    execute(command) {
      log.debug("worker fixture execute");
      return { value: command.input };
    },
    async close() {
      await Promise.resolve();
      for (let index = 0; index < 128; index++) {
        log.debug(`worker teardown diagnostic ${index}`);
      }
      log.debug("worker fixture close");
    },
  };
}

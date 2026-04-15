export const loggingState = {
  cachedLogger: null as unknown,
  cachedSettings: null as unknown,
  /** Incremented each time the file logger is rebuilt due to config changes. */
  loggerGeneration: 0,
  cachedConsoleSettings: null as unknown,
  overrideSettings: null as unknown,
  invalidEnvLogLevelValue: null as string | null,
  consolePatched: false,
  forceConsoleToStderr: false,
  consoleTimestampPrefix: false,
  consoleSubsystemFilter: null as string[] | null,
  resolvingConsoleSettings: false,
  streamErrorHandlersInstalled: false,
  rawConsole: null as {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null,
};

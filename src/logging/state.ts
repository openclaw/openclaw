export const loggingState = {
  cachedLogger: null as unknown,
  cachedSettings: null as unknown,
  // Bumped whenever the base file logger is rebuilt (settings change or daily
  // rolling-log path turning over). Long-lived subsystem loggers compare their
  // own captured generation against this to know when to refetch the child
  // logger and pick up the new file transport.
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

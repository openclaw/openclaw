const LOGGING_STATE_KEY = Symbol.for("openclaw.loggingState");

type LoggingState = {
  cachedLogger: unknown;
  cachedSettings: unknown;
  cachedConsoleSettings: unknown;
  overrideSettings: unknown;
  consolePatched: boolean;
  forceConsoleToStderr: boolean;
  consoleTimestampPrefix: boolean;
  consoleSubsystemFilter: string[] | null;
  resolvingConsoleSettings: boolean;
  streamErrorHandlersInstalled: boolean;
  rawConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null;
};

function createLoggingState(): LoggingState {
  return {
    cachedLogger: null,
    cachedSettings: null,
    cachedConsoleSettings: null,
    overrideSettings: null,
    consolePatched: false,
    forceConsoleToStderr: false,
    consoleTimestampPrefix: false,
    consoleSubsystemFilter: null,
    resolvingConsoleSettings: false,
    streamErrorHandlersInstalled: false,
    rawConsole: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRawConsole(value: unknown): value is LoggingState["rawConsole"] {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.log === "function" &&
    typeof value.info === "function" &&
    typeof value.warn === "function" &&
    typeof value.error === "function"
  );
}

function isLoggingState(value: unknown): value is LoggingState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.consolePatched === "boolean" &&
    typeof value.forceConsoleToStderr === "boolean" &&
    typeof value.consoleTimestampPrefix === "boolean" &&
    (value.consoleSubsystemFilter === null ||
      (Array.isArray(value.consoleSubsystemFilter) &&
        value.consoleSubsystemFilter.every((entry) => typeof entry === "string"))) &&
    typeof value.resolvingConsoleSettings === "boolean" &&
    typeof value.streamErrorHandlersInstalled === "boolean" &&
    isRawConsole(value.rawConsole)
  );
}

export const loggingState: LoggingState = (() => {
  const g = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = g[LOGGING_STATE_KEY];
  if (isLoggingState(existing)) {
    return existing;
  }
  const created = createLoggingState();
  g[LOGGING_STATE_KEY] = created;
  return created;
})();

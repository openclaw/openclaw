export type LogTransport = (logObj: Record<string, unknown>) => void;

// Use globalThis to ensure shared state across module instances (e.g., when plugins are loaded via jiti)
type LoggingGlobalState = {
  cachedLogger: unknown;
  cachedSettings: unknown;
  cachedConsoleSettings: unknown;
  overrideSettings: unknown;
  consolePatched: boolean;
  forceConsoleToStderr: boolean;
  consoleTimestampPrefix: boolean;
  consoleSubsystemFilter: string[] | null;
  resolvingConsoleSettings: boolean;
  rawConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null;
  externalTransports: Set<LogTransport>;
};

const GLOBAL_KEY = Symbol.for("openclaw.logging.state");

function getGlobalLoggingState(): LoggingGlobalState {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: LoggingGlobalState };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      cachedLogger: null,
      cachedSettings: null,
      cachedConsoleSettings: null,
      overrideSettings: null,
      consolePatched: false,
      forceConsoleToStderr: false,
      consoleTimestampPrefix: false,
      consoleSubsystemFilter: null,
      resolvingConsoleSettings: false,
      rawConsole: null,
      externalTransports: new Set(),
    };
  }
  return g[GLOBAL_KEY];
}

export const loggingState = getGlobalLoggingState();

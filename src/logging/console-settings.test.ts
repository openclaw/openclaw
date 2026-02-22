import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  readLoggingConfig: () => undefined,
}));

vi.mock("./logger.js", () => ({
  getLogger: () => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  }),
}));

let loadConfigCalls = 0;
type ConsoleSnapshot = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.trace;
};

let originalIsTty: boolean | undefined;
let snapshot: ConsoleSnapshot;
let logging: typeof import("../logging.js");
let state: typeof import("./state.js");

beforeAll(async () => {
  logging = await import("../logging.js");
  state = await import("./state.js");
});

beforeEach(() => {
  loadConfigCalls = 0;
  snapshot = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  originalIsTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  logging.setConsoleConfigLoaderForTests();
  vi.restoreAllMocks();
});

function loadLogging() {
  state.loggingState.cachedConsoleSettings = null;
  logging.setConsoleConfigLoaderForTests(() => {
    loadConfigCalls += 1;
    if (loadConfigCalls > 5) {
      return {};
    }
    console.error("config load failed");
    return {};
  });
  return { logging, state };
}

describe("getConsoleSettings", () => {
  it("does not recurse when loadConfig logs during resolution", () => {
    const { logging } = loadLogging();
    logging.setConsoleTimestampPrefix(true);
    logging.enableConsoleCapture();
    const { getConsoleSettings } = logging;
    getConsoleSettings();
    expect(loadConfigCalls).toBe(1);
  });

  it("skips config fallback during re-entrant resolution", () => {
    const { logging, state } = loadLogging();
    state.loggingState.resolvingConsoleSettings = true;
    logging.setConsoleTimestampPrefix(true);
    logging.enableConsoleCapture();
    logging.getConsoleSettings();
    expect(loadConfigCalls).toBe(0);
    state.loggingState.resolvingConsoleSettings = false;
  });
});

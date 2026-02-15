import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

afterEach(async () => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  const logging = await import("../logging.js");
  logging.setConsoleConfigLoaderForTests();
  vi.restoreAllMocks();
});

async function loadLogging() {
  const logging = await import("../logging.js");
  const state = await import("./state.js");
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
  it("does not recurse when loadConfig logs during resolution", async () => {
    const { logging } = await loadLogging();
    logging.setConsoleTimestampPrefix(true);
    logging.enableConsoleCapture();
    const { getConsoleSettings } = logging;
    getConsoleSettings();
    expect(loadConfigCalls).toBe(1);
  });

  it("skips config fallback during re-entrant resolution", async () => {
    const { logging, state } = await loadLogging();
    state.loggingState.resolvingConsoleSettings = true;
    logging.setConsoleTimestampPrefix(true);
    logging.enableConsoleCapture();
    logging.getConsoleSettings();
    expect(loadConfigCalls).toBe(0);
    state.loggingState.resolvingConsoleSettings = false;
  });
});

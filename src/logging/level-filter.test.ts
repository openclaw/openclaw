// Level filter tests cover logger filtering by configured log level.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { levelToMinLevel } from "./levels.js";

const { readLoggingConfigMock } = vi.hoisted(() => ({
  readLoggingConfigMock: vi.fn<() => { level: "silent" } | { consoleLevel: "silent" } | undefined>(
    () => undefined,
  ),
}));

vi.mock("./config.js", () => ({
  invalidateLoggingConfigCache: vi.fn(),
  readLoggingConfig: readLoggingConfigMock,
}));

let envSnapshot: ReturnType<typeof captureEnv> | undefined;
let logging: typeof import("./logger.js");
let consoleLogging: typeof import("./console.js");

beforeAll(async () => {
  // A sibling may retain an older logger; this suite observes its own config mock.
  vi.resetModules();
  logging = await import("./logger.js");
  consoleLogging = await import("./console.js");
});

beforeEach(() => {
  envSnapshot = captureEnv([
    "OPENCLAW_TEST_FILE_LOG",
    "OPENCLAW_TEST_CONSOLE",
    "OPENCLAW_LOG_LEVEL",
  ]);
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_TEST_CONSOLE;
  delete process.env.OPENCLAW_LOG_LEVEL;
  readLoggingConfigMock.mockClear();
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  envSnapshot?.restore();
  envSnapshot = undefined;
  logging.resetLogger();
  logging.setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("resolved logging settings cache", () => {
  it("loads file settings once per logger generation", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    readLoggingConfigMock.mockReturnValue({ level: "silent" });

    logging.getLogger();
    logging.getLogger();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride({ level: "silent" });
    logging.getLogger();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride(null);
    logging.getLogger();
    logging.getLogger();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(2);
  });

  it("reuses settings resolved by the file-level admission check when building the logger", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    readLoggingConfigMock.mockReturnValue({ level: "silent" });

    expect(logging.isFileLogLevelEnabled("info")).toBe(false);
    logging.getLogger();

    expect(readLoggingConfigMock).toHaveBeenCalledOnce();
  });

  it("loads console settings once per logger generation", () => {
    process.env.OPENCLAW_TEST_CONSOLE = "1";
    readLoggingConfigMock.mockReturnValue({ consoleLevel: "silent" });
    logging.setLoggerOverride(null);
    readLoggingConfigMock.mockClear();

    consoleLogging.getConsoleSettings();
    consoleLogging.getConsoleSettings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride({ consoleLevel: "silent" });
    consoleLogging.getConsoleSettings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride(null);
    consoleLogging.getConsoleSettings();
    consoleLogging.getConsoleSettings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("isFileLogLevelEnabled", () => {
  for (const { name, level, expected } of [
    {
      name: "returns false for all levels when configured as silent",
      level: "silent",
      expected: [false, false, false, false, false, false],
    },
    {
      name: "passes fatal, error, warn, info when configured as info",
      level: "info",
      expected: [true, true, true, true, false, false],
    },
    {
      name: "passes all levels when configured as trace",
      level: "trace",
      expected: [true, true, true, true, true, true],
    },
  ] as const) {
    it(name, () => {
      logging.setLoggerOverride({ level });
      expect(logging.isFileLogLevelEnabled("fatal")).toBe(expected[0]);
      expect(logging.isFileLogLevelEnabled("error")).toBe(expected[1]);
      expect(logging.isFileLogLevelEnabled("warn")).toBe(expected[2]);
      expect(logging.isFileLogLevelEnabled("info")).toBe(expected[3]);
      expect(logging.isFileLogLevelEnabled("debug")).toBe(expected[4]);
      expect(logging.isFileLogLevelEnabled("trace")).toBe(expected[5]);
    });
  }

  it("never treats silent as an emittable file level", () => {
    logging.setLoggerOverride({ level: "info" });
    expect(logging.isFileLogLevelEnabled("silent")).toBe(false);
  });
});

describe("getChildLogger minLevel inheritance", () => {
  it("child logger preserves a silent parent without triggering tslog validation", () => {
    logging.setLoggerOverride({ level: "silent" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const child = logging.getChildLogger({ component: "test" });

    expect(child.settings.minLevel).toBe(levelToMinLevel("silent"));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["error", "silent"] as const)("pino child preserves its parent's %s policy", (level) => {
    logging.setLoggerOverride({ level });
    const base = logging.getLogger();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const records: unknown[] = [];
    base.attachTransport((record) => {
      records.push(record);
    });

    const child = logging.toPinoLikeLogger(base, "info").child({ component: "test" });
    child.warn("filtered warning");
    child.error("parent error policy");

    expect(records).toHaveLength(level === "silent" ? 0 : 1);
    expect(JSON.stringify(records)).not.toContain("filtered warning");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

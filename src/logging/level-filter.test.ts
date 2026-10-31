// Level filter tests cover logger filtering by configured log level.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let logging: typeof import("./logger.js");
let consoleLogging: typeof import("./console.js");

beforeAll(async () => {
  // A sibling may retain an older logger; this suite observes its own config mock.
  vi.resetModules();
  logging = await import("./logger.js");
  consoleLogging = await import("./console.js");
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", undefined);
  vi.stubEnv("OPENCLAW_TEST_CONSOLE", undefined);
  vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  readLoggingConfigMock.mockClear();
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  logging.resetLogger();
  logging.setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("resolved logging settings cache", () => {
  it.each(["file", "console"] as const)("loads %s settings once per logger generation", (kind) => {
    const file = kind === "file";
    vi.stubEnv(file ? "OPENCLAW_TEST_FILE_LOG" : "OPENCLAW_TEST_CONSOLE", "1");
    const config = file ? { level: "silent" as const } : { consoleLevel: "silent" as const };
    const settings = file ? logging.getLogger : consoleLogging.getConsoleSettings;
    readLoggingConfigMock.mockReturnValue(config);
    settings();
    settings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);
    logging.setLoggerOverride(config);
    settings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);
    logging.setLoggerOverride(null);
    settings();
    settings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(2);
  });

  it("reuses settings resolved by the file-level admission check when building the logger", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    readLoggingConfigMock.mockReturnValue({ level: "silent" });

    expect(logging.isFileLogLevelEnabled("info")).toBe(false);
    logging.getLogger();

    expect(readLoggingConfigMock).toHaveBeenCalledOnce();
  });
});

describe("isFileLogLevelEnabled", () => {
  it.each([
    ["silent", [false, false, false, false, false, false]],
    ["info", [true, true, true, true, false, false]],
    ["trace", [true, true, true, true, true, true]],
  ] as const)("filters every file level with minimum %s", (level, expected) => {
    logging.setLoggerOverride({ level });
    const levels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
    expect(levels.map((value) => logging.isFileLogLevelEnabled(value))).toEqual(expected);
  });

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

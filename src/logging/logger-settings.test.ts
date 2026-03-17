import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fallbackRequireMock, readLoggingConfigMock } = vi.hoisted(() => ({
  readLoggingConfigMock: vi.fn(
    (): import("../config/types.base.js").LoggingConfig | undefined => undefined,
  ),
  fallbackRequireMock: vi.fn(() => {
    throw new Error("config fallback should not be used in this test");
  }),
}));

vi.mock("./config.js", () => ({
  readLoggingConfig: readLoggingConfigMock,
}));

vi.mock("./node-require.js", () => ({
  resolveNodeRequireFromMeta: () => fallbackRequireMock,
}));

let originalTestFileLog: string | undefined;
let originalOpenClawLogLevel: string | undefined;
let logging: typeof import("../logging.js");

beforeAll(async () => {
  logging = await import("../logging.js");
});

beforeEach(() => {
  originalTestFileLog = process.env.OPENCLAW_TEST_FILE_LOG;
  originalOpenClawLogLevel = process.env.OPENCLAW_LOG_LEVEL;
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_LOG_LEVEL;
  readLoggingConfigMock.mockClear();
  fallbackRequireMock.mockClear();
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  if (originalTestFileLog === undefined) {
    delete process.env.OPENCLAW_TEST_FILE_LOG;
  } else {
    process.env.OPENCLAW_TEST_FILE_LOG = originalTestFileLog;
  }
  if (originalOpenClawLogLevel === undefined) {
    delete process.env.OPENCLAW_LOG_LEVEL;
  } else {
    process.env.OPENCLAW_LOG_LEVEL = originalOpenClawLogLevel;
  }
  logging.resetLogger();
  logging.setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("getResolvedLoggerSettings", () => {
  it("uses a silent fast path in default Vitest mode without config reads", () => {
    const settings = logging.getResolvedLoggerSettings();
    expect(settings.level).toBe("silent");
    expect(readLoggingConfigMock).not.toHaveBeenCalled();
    expect(fallbackRequireMock).not.toHaveBeenCalled();
  });

  it("reads logging config when test file logging is explicitly enabled", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    const settings = logging.getResolvedLoggerSettings();
    expect(settings.level).toBe("info");
  });

  it("uses logging.dir for rolling log path when set", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    logging.setLoggerOverride({ dir: "/custom/logs" });
    const settings = logging.getResolvedLoggerSettings();
    expect(settings.file).toMatch(/^\/custom\/logs\/openclaw-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it("logging.file takes priority over logging.dir", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    logging.setLoggerOverride({ dir: "/custom/logs", file: "/exact/path.log" });
    const settings = logging.getResolvedLoggerSettings();
    expect(settings.file).toBe("/exact/path.log");
  });

  it("uses default dir when neither file nor dir is set", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    logging.setLoggerOverride({});
    const settings = logging.getResolvedLoggerSettings();
    expect(settings.file).toMatch(/^\/tmp\/openclaw\/openclaw-\d{4}-\d{2}-\d{2}\.log$/);
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fallbackRequireMock, readLoggingConfigMock } = vi.hoisted(() => ({
  readLoggingConfigMock: vi.fn(() => undefined),
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
  it("substitutes YYYY-MM-DD placeholder in configured file path with actual date", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    const customDir = "/tmp/custom-logs";
    logging.setLoggerOverride({
      level: "info",
      file: `${customDir}/openclaw-YYYY-MM-DD.log`,
    });
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const expected = `${customDir}/openclaw-${yyyy}-${mm}-${dd}.log`;
    expect(logging.getResolvedLoggerSettings().file).toBe(expected);
  });

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
});

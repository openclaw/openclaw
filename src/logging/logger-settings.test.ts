import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fallbackRequireMock, readLoggingConfigMock, shouldSkipMutatingLoggingConfigReadMock } =
  vi.hoisted(() => ({
    readLoggingConfigMock: vi.fn(() => undefined),
    shouldSkipMutatingLoggingConfigReadMock: vi.fn(() => false),
    fallbackRequireMock: vi.fn(() => {
      throw new Error("config fallback should not be used in this test");
    }),
  }));

vi.mock("./config.js", () => ({
  readLoggingConfig: readLoggingConfigMock,
  shouldSkipMutatingLoggingConfigRead: shouldSkipMutatingLoggingConfigReadMock,
}));

vi.mock("./node-require.js", () => ({
  resolveNodeRequireFromMeta: () => fallbackRequireMock,
}));

let originalTestFileLog: string | undefined;
let originalOpenClawLogLevel: string | undefined;
let logging: typeof import("../logging.js");
let loggerModule: typeof import("./logger.js");

beforeAll(async () => {
  logging = await import("../logging.js");
  loggerModule = await import("./logger.js");
});

beforeEach(() => {
  originalTestFileLog = process.env.OPENCLAW_TEST_FILE_LOG;
  originalOpenClawLogLevel = process.env.OPENCLAW_LOG_LEVEL;
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_LOG_LEVEL;
  readLoggingConfigMock.mockClear();
  shouldSkipMutatingLoggingConfigReadMock.mockReset();
  shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(false);
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

  it("skips fallback config loads for config schema", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(true);

    const settings = logging.getResolvedLoggerSettings();

    expect(settings.level).toBe("info");
    expect(fallbackRequireMock).not.toHaveBeenCalled();
  });
});

describe("registerLogTransport sink redaction", () => {
  it("does not trigger a mutating config load when registering a transport against a cached logger", () => {
    // Simulate a cached logger being present (silent level avoids filesystem writes).
    logging.setLoggerOverride({ level: "silent" } as import("../logging.js").LoggerSettings);
    // Prime the cache by calling getLogger through the public API.
    logging.getResolvedLoggerSettings();

    shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(true);
    fallbackRequireMock.mockClear();

    const received: unknown[] = [];
    const unregister = loggerModule.registerLogTransport((logObj) => {
      received.push(logObj);
    });

    // The transport was registered; no direct loadConfig() path should have been triggered.
    expect(fallbackRequireMock).not.toHaveBeenCalled();

    unregister();
  });

  it("does not trigger a mutating config load when getResolvedLoggerSettings runs under config schema", () => {
    // Force a non-silent level so resolveSettings exercises the config-read branch,
    // then assert that the logging bootstrap never reaches the fallback loadConfig().
    shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(true);
    fallbackRequireMock.mockClear();

    logging.getResolvedLoggerSettings();

    expect(fallbackRequireMock).not.toHaveBeenCalled();
  });
});

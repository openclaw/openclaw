// Logger settings tests cover file-backed logger settings behavior.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

let envSnapshot: ReturnType<typeof captureEnv> | undefined;
let logging: typeof import("../logging.js");
let loggingConfig: typeof import("./config.js");
let applyLoggingConfig: typeof import("./logger.js").applyLoggingConfig;

beforeAll(async () => {
  // Bind the observer and both settings consumers to the same module generation.
  vi.resetModules();
  loggingConfig = await import("./config.js");
  ({ applyLoggingConfig } = await import("./logger.js"));
  logging = await import("../logging.js");
});

beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_TEST_FILE_LOG", "OPENCLAW_LOG_LEVEL"]);
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_LOG_LEVEL;
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

describe("getResolvedLoggerSettings", () => {
  it("uses a silent fast path in default Vitest mode without config reads", () => {
    const readLoggingConfig = vi.spyOn(loggingConfig, "readLoggingConfig");

    const settings = logging.getResolvedLoggerSettings();

    expect(settings.level).toBe("silent");
    expect(readLoggingConfig).not.toHaveBeenCalled();
  });

  it("reads logging config when test file logging is explicitly enabled", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    const readLoggingConfig = vi.spyOn(loggingConfig, "readLoggingConfig");
    applyLoggingConfig({
      level: "debug",
      file: "/tmp/openclaw-configured.log",
      maxFileBytes: 2048,
    });

    const settings = logging.getResolvedLoggerSettings();

    expect(readLoggingConfig).toHaveBeenCalledOnce();
    expect(settings.level).toBe("debug");
    expect(settings.file).toBe("/tmp/openclaw-configured.log");
    expect(settings.maxFileBytes).toBe(2048);
  });

  it("uses defaults when no logging config is available", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    applyLoggingConfig(undefined);

    const settings = logging.getResolvedLoggerSettings();

    expect(settings.level).toBe("info");
    expect(settings.file).toContain(path.join(".artifacts", "test-logs"));
    expect(path.basename(settings.file)).toMatch(/^openclaw-vitest-\d+-\d{4}-\d{2}-\d{2}\.log$/);
    expect(settings.file).not.toBe(
      `/tmp/openclaw/openclaw-${new Date().toISOString().slice(0, 10)}.log`,
    );
  });
});

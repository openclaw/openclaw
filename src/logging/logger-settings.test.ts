// Logger settings tests cover file-backed logger settings behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";

let logging: typeof import("../logging.js");
let loggingConfig: typeof import("./config.js");
let applyLoggingConfig: typeof import("./logger.js").applyLoggingConfig;
let getLogger: typeof import("./logger.js").getLogger;
let flushLogger: typeof import("./logger.js").flushLogger;
let getResolvedLoggerFileTarget: typeof import("./logger.js").getResolvedLoggerFileTarget;

beforeAll(async () => {
  // Bind the observer and both settings consumers to the same module generation.
  vi.resetModules();
  loggingConfig = await import("./config.js");
  ({ applyLoggingConfig, getLogger, flushLogger, getResolvedLoggerFileTarget } =
    await import("./logger.js"));
  logging = await import("../logging.js");
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", undefined);
  vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it.each([false, true])(
    "keeps silent file logging artifact-free (override: %s)",
    async (override) => {
      await withTempDir("openclaw-silent-logs-", async (root) => {
        const stateDir = path.join(root, "absent");
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        if (override) {
          logging.setLoggerOverride({ level: "silent" });
        }
        expect(logging.getResolvedLoggerSettings().level).toBe("silent");
        getLogger().warn("disabled file record");
        expect(fs.existsSync(stateDir)).toBe(false);
      });
    },
  );

  it.each([false, true])(
    "admits the default file only on emission (unsafe: %s)",
    async (unsafe) => {
      await withTempDir("openclaw-active-logs-", async (root) => {
        const stateDir = path.join(root, "state");
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("VITEST", undefined);
        logging.setLoggerOverride({ level: "info" });
        expect(logging.getResolvedLoggerSettings().level).toBe("info");
        const logger = getLogger();
        logger.debug("filtered record");
        expect(fs.existsSync(stateDir)).toBe(false);
        const outside = path.join(root, "outside");
        if (unsafe) {
          fs.mkdirSync(stateDir, { mode: 0o700 });
          fs.mkdirSync(outside);
          fs.symlinkSync(outside, path.join(stateDir, "logs"), "junction");
        }
        logger.info("admitted record");
        await flushLogger();
        const { file } = getResolvedLoggerFileTarget();
        const content = fs.readFileSync(file, "utf8");
        expect(content).toContain("admitted record");
        expect(content).not.toContain("filtered record");
        if (unsafe) {
          expect(fs.readdirSync(outside)).toEqual([]);
          expect(file.startsWith(path.join(stateDir, "tmp") + path.sep)).toBe(true);
        }
      });
    },
  );

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

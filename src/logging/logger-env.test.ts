import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { getConsoleSettings } from "./console.js";
import { getResolvedLoggerSettings, resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";

const defaultMaxFileBytes = 100 * 1024 * 1024;
const testLogPath = path.join(os.tmpdir(), "openclaw-test-env-log-level.log");
function configure(overrides: Parameters<typeof setLoggerOverride>[0]) {
  setLoggerOverride({
    level: "error",
    consoleLevel: "warn",
    consoleStyle: "compact",
    file: testLogPath,
    ...overrides,
  });
}
const captureStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const envWarnings = (spy: ReturnType<typeof captureStderr>) =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("OPENCLAW_LOG_LEVEL"));

describe("OPENCLAW_LOG_LEVEL", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_LOG_LEVEL"]);
    delete process.env.OPENCLAW_LOG_LEVEL;
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
  });

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    loggingState.invalidEnvLogLevelValue = null;
    resetLogger();
    setLoggerOverride(null);
    vi.restoreAllMocks();
  });

  it("applies a valid env override to both file and console levels", () => {
    configure({ consoleStyle: "json" });
    process.env.OPENCLAW_LOG_LEVEL = "debug";

    expect(getResolvedLoggerSettings()).toEqual({
      level: "debug",
      file: testLogPath,
      maxFileBytes: defaultMaxFileBytes,
    });
    expect(getConsoleSettings()).toEqual({ level: "debug", style: "json" });
  });

  it("warns once and ignores invalid env values", () => {
    configure({});
    process.env.OPENCLAW_LOG_LEVEL = "nope";
    const stderrSpy = captureStderr();

    expect(getResolvedLoggerSettings().level).toBe("error");
    expect(getResolvedLoggerSettings().maxFileBytes).toBe(defaultMaxFileBytes);
    expect(getConsoleSettings().level).toBe("warn");
    expect(getResolvedLoggerSettings().level).toBe("error");

    const warnings = envWarnings(stderrSpy);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"');
  });

  it("structures invalid env warnings for JSON console output", () => {
    configure({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    process.env.OPENCLAW_LOG_LEVEL = "nope";
    const stderrSpy = captureStderr();

    expect(getConsoleSettings().level).toBe("info");

    const [warning] = envWarnings(stderrSpy);
    expect(JSON.parse(warning ?? "")).toMatchObject({
      level: "warn",
      message: expect.stringContaining('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"'),
    });
  });

  it.each(["compact", "json"] as const)(
    "redacts invalid env values in %s warnings",
    (consoleStyle) => {
      const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"; // pragma: allowlist secret
      setLoggerOverride({ level: "silent", consoleStyle, file: testLogPath });
      process.env.OPENCLAW_LOG_LEVEL = secret;
      const stderrSpy = captureStderr();

      getResolvedLoggerSettings();

      expect(stderrSpy).toHaveBeenCalledOnce();
      const warning = String(stderrSpy.mock.calls[0]?.[0]);
      expect(warning).toContain("Ignoring invalid OPENCLAW_LOG_LEVEL=");
      expect(warning).not.toContain(secret);
    },
  );
});

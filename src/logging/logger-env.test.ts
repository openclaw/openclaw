import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  spy.mock.calls.map(([line]) => String(line));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  loggingState.invalidEnvLogLevelValue = null;
  resetLogger();
});

afterEach(() => {
  vi.unstubAllEnvs();
  loggingState.invalidEnvLogLevelValue = null;
  resetLogger();
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

it.each([
  ["compact", "error", "warn"],
  ["json", "silent", "info"],
] as const)(
  "warns once and ignores invalid env values (%s)",
  (consoleStyle, level, consoleLevel) => {
    configure({ consoleStyle, level, consoleLevel });
    process.env.OPENCLAW_LOG_LEVEL = "nope";
    const stderrSpy = captureStderr();
    expect(getConsoleSettings().level).toBe(consoleLevel);
    expect(getResolvedLoggerSettings()).toMatchObject({ level, maxFileBytes: defaultMaxFileBytes });
    expect(getResolvedLoggerSettings().level).toBe(level);
    const warnings = envWarnings(stderrSpy);
    expect(warnings).toHaveLength(1);
    if (consoleStyle === "json") {
      expect(JSON.parse(warnings[0] ?? "")).toMatchObject({
        level: "warn",
        message: expect.stringContaining('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"'),
      });
    } else {
      expect(warnings[0]).toContain('Ignoring invalid OPENCLAW_LOG_LEVEL="nope"');
    }
  },
);

it.each(["compact", "json"] as const)("redacts %s env warnings", (consoleStyle) => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"; // pragma: allowlist secret
  setLoggerOverride({ level: "silent", consoleStyle, file: testLogPath });
  process.env.OPENCLAW_LOG_LEVEL = secret;
  const stderrSpy = captureStderr();

  getResolvedLoggerSettings();

  expect(stderrSpy).toHaveBeenCalledOnce();
  const warning = String(stderrSpy.mock.calls[0]?.[0]);
  expect(warning).toContain("Ignoring invalid OPENCLAW_LOG_LEVEL=");
  expect(warning).not.toContain(secret);
});

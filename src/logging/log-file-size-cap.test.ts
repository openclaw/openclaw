import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { getLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { testApi } from "./logger.test-support.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-log-cap-");

let logPath = "";
const configure = (settings: Parameters<typeof setLoggerOverride>[0] = {}) =>
  setLoggerOverride({ level: "info", file: logPath, ...settings });
const captureStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const rotationWarnings = (spy: ReturnType<typeof captureStderr>) =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("log file rotation failed"));

beforeAll(() => logPathTracker.setup());

beforeEach(() => {
  logPath = logPathTracker.nextPath();
  resetLogger();
});

afterEach(() => {
  resetLogger();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => logPathTracker.cleanup());

it("rotates file writes after cap is reached and keeps logging", async () => {
  const stderrSpy = captureStderr();
  configure({ maxFileBytes: 256 });
  const logger = getLogger();

  logger.error(`network-failure-${"x".repeat(400)}`);
  logger.error("post-rotation-diagnostic");
  await testApi.flushFileLogQueueForTests();

  const currentContent = fs.readFileSync(logPath, "utf8");
  const archiveContent = fs.readFileSync(logPath.replace(/\.log$/, ".1.log"), "utf8");
  expect(currentContent).toContain("post-rotation-diagnostic");
  expect(currentContent).not.toContain("network-failure");
  expect(archiveContent).toContain("network-failure");
  expect(rotationWarnings(stderrSpy)).toHaveLength(0);
});

it("structures rotation failure diagnostics for JSON console output", async () => {
  fs.writeFileSync(logPath, "seed");
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("rotation denied");
  });
  const stderrSpy = captureStderr();
  configure({ maxFileBytes: 1, consoleLevel: "info", consoleStyle: "json" });

  getLogger().error("rotation diagnostic");
  await testApi.flushFileLogQueueForTests();

  const [warning] = rotationWarnings(stderrSpy);
  expect(JSON.parse(warning ?? "")).toMatchObject({
    level: "warn",
    message: expect.stringContaining("log file rotation failed"),
  });
});

it.each([
  { name: "default rolling", prefix: "openclaw", rolls: true },
  { name: "explicit profile-shaped", prefix: "openclaw-dev", rolls: false },
])("$name loggers respect date changes", async ({ prefix, rolls }) => {
  const logDir = path.dirname(logPath);
  const firstDay = path.join(logDir, `${prefix}-2026-01-01.log`);
  const secondDay = path.join(logDir, `${prefix}-2026-01-02.log`);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
  setLoggerOverride({ level: "info", file: firstDay });
  const logger = getLogger();

  logger.info({ message: "first day" });
  vi.setSystemTime(new Date("2026-01-02T08:00:00Z"));
  logger.info({ message: "second day" });
  await testApi.flushFileLogQueueForTests();

  const firstContent = fs.readFileSync(firstDay, "utf8");
  expect(firstContent).toContain("first day");
  if (rolls) {
    expect(fs.readFileSync(secondDay, "utf8")).toContain("second day");
    expect(firstContent).not.toContain("second day");
  } else {
    expect(firstContent).toContain("second day");
    expect(fs.existsSync(secondDay)).toBe(false);
  }
});

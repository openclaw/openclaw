import fs from "node:fs";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { LogLevel } from "./levels.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import {
  applyLoggingConfig,
  flushLogger,
  getChildLogger,
  getLogger,
  resetLogger,
  toPinoLikeLogger,
} from "./logger.js";

const paths = createSuiteLogPathTracker("openclaw-logger-reload-");
const child = (module = "retained", level?: LogLevel) => getChildLogger({ module }, { level });
const read = (file: string) => fs.readFileSync(file, "utf8");
function expectLog(file: string, visible: string, hidden?: string) {
  const text = read(file);
  expect(text).toContain(visible);
  if (hidden) {
    expect(text).not.toContain(hidden);
  }
  return text;
}
beforeAll(() => paths.setup());
beforeEach(() => {
  resetLogger();
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "");
});
afterEach(async () => {
  await flushLogger();
  resetLogger();
  vi.unstubAllEnvs();
});
afterAll(() => paths.cleanup());

it.each([
  ["root", getLogger],
  ["child", () => child()],
  ["nested child", () => child().getSubLogger({ name: "nested" })],
  ["pino child", () => toPinoLikeLogger(child(), "info").child({ component: "nested" })],
] as const)(
  "refreshes retained %s across silent, file and level changes",
  async (_name, create) => {
    const first = paths.nextPath();
    const second = paths.nextPath();
    applyLoggingConfig({ level: "silent", file: first });
    const logger = create();
    logger.info("hidden before enable");
    applyLoggingConfig({ level: "info", file: first });
    logger.info("first target");
    logger.debug("hidden before debug");
    applyLoggingConfig({ level: "debug", file: second });
    logger.debug("second target");
    applyLoggingConfig({ level: "silent", file: second });
    logger.error("hidden after disable");
    await flushLogger();
    const firstText = expectLog(first, "first target", "second target");
    const secondText = expectLog(second, "second target", "first target");
    expect(firstText + secondText).not.toContain("hidden");
  },
);

it("preserves explicit levels and later nested settings assignments", async () => {
  const first = paths.nextPath();
  const second = paths.nextPath();
  applyLoggingConfig({ level: "error", file: first });
  const logger = child("verbose", "debug");
  const nested = logger.getSubLogger({ name: "nested" });
  const silent = toPinoLikeLogger(child("quiet", "silent"), "silent").child({ component: "child" });
  expect(logger).toBeInstanceOf(TsLogger);
  nested.debug("explicit debug");
  logger.settings.minLevel = 4;
  applyLoggingConfig({ level: "trace", file: second });
  nested.debug("hidden after assignment");
  nested.warn("assigned warning");
  silent.error("hidden explicit silent");
  expect(silent.level).toBe("silent");
  await flushLogger();
  expectLog(first, "explicit debug");
  expectLog(second, "assigned warning", "hidden");
});

it("applies new file size limits to existing children", async () => {
  const file = paths.nextPath();
  applyLoggingConfig({ level: "info", file, maxFileBytes: 1_000_000 });
  const logger = child("rotation");
  logger.info("before smaller limit");
  await flushLogger();
  applyLoggingConfig({ level: "info", file, maxFileBytes: 1 });
  logger.info("after smaller limit");
  await flushLogger();
  const archive = path.join(path.dirname(file), `${path.basename(file, ".log")}.1.log`);
  expectLog(archive, "before smaller limit");
  expectLog(file, "after smaller limit");
});

it("leaves third-party loggers under their own policy", () => {
  const logger = new TsLogger<{ date?: Date } & Record<string, unknown>>({
    minLevel: 4,
    type: "hidden",
  });
  const records: unknown[] = [];
  logger.attachTransport((record) => {
    records.push(record);
  });
  const adapter = toPinoLikeLogger(logger, "warn").child({ component: "external" });
  applyLoggingConfig({ level: "silent", file: paths.nextPath() });
  adapter.info("hidden external info");
  adapter.warn({ event: "external" }, { detail: "retained" }, "external warning");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "0": { event: "external" },
    "1": { detail: "retained" },
    "2": "external warning",
    _logMeta: { logLevelName: "WARN" },
  });
});

it("keeps Pino inheritance across module copies", async () => {
  const file = paths.nextPath();
  applyLoggingConfig({ level: "silent", file });
  const logger = child("retained-module");
  vi.resetModules();
  const reloaded = await import("./logger.js");
  const adapter = reloaded.toPinoLikeLogger(logger, "info").child({ component: "later-copy" });
  reloaded.applyLoggingConfig({ level: "info", file });
  adapter.info("enabled through another module copy");
  await flushLogger();
  expectLog(file, "enabled through another module copy");
});

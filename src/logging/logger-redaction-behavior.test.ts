// File logs preserve raw values; diagnostic emission owns its redaction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import { afterAll, afterEach, beforeAll, beforeEach, assert, expect, it, vi } from "vitest";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  createSubsystemLogger as createPluginSubsystemLogger,
  getChildLogger as getPluginChildLogger,
} from "../plugin-sdk/logging-core.js";
import { PluginStateStoreError } from "../plugin-state/plugin-state-store.types.js";
import {
  capturePluginStateWorkerFailure,
  restorePluginStateWorkerFailure,
} from "../plugin-state/plugin-state-worker-errors.js";
import { withEnv } from "../test-utils/env.js";
import type { LogLevel } from "./levels.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { fileLogTransport } from "./logger-file-transport.js";
import {
  applyLoggingConfig,
  flushLogger,
  getChildLogger,
  getLogger,
  resetLogger,
  setLoggerOverride,
  toPinoLikeLogger,
} from "./logger.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";
import { loggingState } from "./state.js";

const pluginStateSecret = "sk-testsecret1234567890abcd";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const logPathTracker = createSuiteLogPathTracker("openclaw-log-redaction-");
let logPath: string;
let rawConsole: typeof loggingState.rawConsole;

async function readLogFile(): Promise<string> {
  await flushLogger();
  return fs.readFileSync(logPath, "utf8");
}

async function readRecords() {
  return (await readLogFile())
    .trim()
    .split("\n")
    .map((line): Record<string, unknown> => JSON.parse(line));
}

beforeAll(() => logPathTracker.setup());

beforeEach(() => {
  rawConsole = loggingState.rawConsole;
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "");
  logPath = logPathTracker.nextPath();
  setLoggerOverride({ level: "info", file: logPath });
});

afterEach(async () => {
  await flushLogger();
  resetLogger();
  resetSecretRedactionRegistryForTest();
  loggingState.rawConsole = rawConsole;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => logPathTracker.cleanup());
it.each([{ aggregate: false }, { aggregate: true }])(
  "retains plugin-state failure origin and raw causes (aggregate=$aggregate)",
  async ({ aggregate }) => {
    const native = Object.assign(
      new Error(`Permission denied; Authorization: Bearer ${pluginStateSecret}`),
      {
        code: "EACCES",
        errno: -13,
        privateData: "unrelated stored value",
      },
    );
    const cause = aggregate
      ? new AggregateError([native], "Synthetic admission failed", {
          cause: new Error("Synthetic cleanup failed"),
        })
      : new Error("Synthetic admission failed", { cause: native });
    if (cause instanceof AggregateError) {
      cause.errors.push(cause);
    }
    const owner = { pid: 12345, threadId: 7, version: "2026.9.6" };
    const details = {
      code: "PLUGIN_STATE_OPEN_FAILED",
      operation: "entries",
      path: "/synthetic/state/openclaw.sqlite",
      owner,
    } satisfies ConstructorParameters<typeof PluginStateStoreError>[1];
    const original = new PluginStateStoreError("Failed to open the plugin state database.", {
      ...details,
      cause,
    });
    const error = restorePluginStateWorkerFailure(
      structuredClone(capturePluginStateWorkerFailure(original)),
    );
    getChildLogger({ subsystem: "plugin-state-proof" }).warn({ error }, "Background update failed");

    const content = await readLogFile();
    const record = JSON.parse(content.trim());
    const nativeDetails = {
      message: expect.stringContaining("Permission denied"),
      errorCode: "EACCES",
      errno: -13,
    };
    expect(record["1"].error).toMatchObject({
      name: "PluginStateStoreError",
      message: "Failed to open the plugin state database.",
      ...details,
      cause: {
        message: "Synthetic admission failed",
        ...(aggregate
          ? {
              cause: { message: "Synthetic cleanup failed" },
              errors: [nativeDetails, { message: "Additional SQLite error cause omitted" }],
            }
          : { cause: nativeDetails }),
      },
    });
    expect(content).toContain(pluginStateSecret);
    expect((await readConfiguredLogTail()).lines.join("\n")).not.toContain(pluginStateSecret);
    expect(content).not.toContain("unrelated stored value");
    expect(record["1"].error).not.toHaveProperty("stack");
  },
);

it("uses logging.file from the active config path", async () => {
  setLoggerOverride(null);
  const configPath = logPathTracker.nextPath();
  fs.writeFileSync(configPath, JSON.stringify({ logging: { level: "info", file: logPath } }));
  withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FILE_LOG: "1" }, () => {
    getLogger().info({ message: "configured log path works" });
  });
  const content = await readLogFile();
  expect(content).toContain("configured log path works");
});

it("writes binding trace context ahead of active scope", async () => {
  const trace = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: "00f067aa0ba902b8",
    traceFlags: "00",
  };
  const logger = getChildLogger({ subsystem: "gateway", trace });
  runWithDiagnosticTraceContext(
    createDiagnosticTraceContext({ traceId: "3bf92f3577b34da6a3ce929d0e0e4736" }),
    () => logger.info({ route: "/api/health" }, "request completed"),
  );
  expect((await readRecords())[0]).toMatchObject(trace);
});

it("captures trace fields before message serialization invokes caller code", async () => {
  const trace = { traceId: TRACE_ID, spanId: SPAN_ID };
  toPinoLikeLogger(getLogger(), "info").info(
    { trace },
    {
      toJSON() {
        trace.traceId = "3bf92f3577b34da6a3ce929d0e0e4736";
        return "serialized";
      },
    },
  );
  expect((await readRecords())[0]).toMatchObject({
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    message: '"serialized"',
  });
});

it("writes active request trace context as top-level JSONL fields", async () => {
  runWithDiagnosticTraceContext(
    createDiagnosticTraceContext({ traceId: TRACE_ID, spanId: SPAN_ID }),
    () => getLogger().info({ route: "/api/health" }, "request completed"),
  );
  expect((await readRecords())[0]).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID });
});

it("keeps bounded file-log messages UTF-16 safe", async () => {
  const prefix = "x".repeat(4_095);
  getLogger().info(`${prefix}😀tail`);
  expect((await readRecords())[0]).toMatchObject({ message: `${prefix}...(truncated)` });
});

it("retries hostname resolution after an empty value and caches the first real value", async () => {
  const logger = getLogger();
  const hostname = vi
    .spyOn(os, "hostname")
    .mockReturnValueOnce("")
    .mockReturnValueOnce("lr-macbook")
    .mockReturnValue("changed-host");
  for (const order of ["first", "second", "third"]) {
    logger.info({ route: "/api/health" }, `${order} request`);
  }
  const records = await readRecords();
  expect(hostname).toHaveBeenCalledTimes(2);
  expect(records).toMatchObject([
    { hostname: "unknown", message: "first request" },
    { hostname: "lr-macbook", message: "second request", _meta: { hostname: "lr-macbook" } },
    { hostname: "lr-macbook", message: "third request" },
  ]);
});

it("promotes agent, session, and channel context to top-level JSONL fields", async () => {
  const logger = getChildLogger({
    agentId: "agent-main",
    messageProvider: "discord",
  });
  logger.info({ sessionKey: "agent:main:discord:channel:c1" }, "session routed");
  expect((await readRecords())[0]).toMatchObject({
    agent_id: "agent-main",
    session_id: "agent:main:discord:channel:c1",
    channel: "discord",
    message: "session routed",
  });
});

async function logToSinks(
  message: string,
  meta?: Record<string, unknown>,
  redactPatterns?: string[],
  write?: (logger: ReturnType<typeof getPluginChildLogger>, file: string) => void,
) {
  vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
  const file = logPathTracker.nextPath();
  applyLoggingConfig({
    level: "info",
    file,
    consoleStyle: "json",
    consoleLevel: "info",
    redactPatterns,
  });
  const output = vi.fn();
  loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
  const logger = createPluginSubsystemLogger("jsonl-proof");
  if (write) {
    write(getPluginChildLogger({ subsystem: "jsonl-proof" }), file);
  } else {
    logger.info(message, meta);
  }
  await flushLogger();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return {
    raw: lines.map((line) => JSON.parse(line))[0],
    console: output.mock.calls.map(([line]) => JSON.parse(String(line))),
  };
}

async function expectMetadata(
  result: Awaited<ReturnType<typeof logToSinks>>,
  raw: Record<string, unknown>,
  redacted: Record<string, unknown>,
) {
  expect(result.raw["1"]).toEqual(raw);
  expect(result.console[0]).toMatchObject(redacted);
  const tail = await readTail();
  expect(tail.record["1"]).toEqual(redacted);
  return tail;
}

async function readTail(limit?: number) {
  const { lines } = await readConfiguredLogTail({ limit });
  assert(lines[0] !== undefined);
  return { record: JSON.parse(lines[0]), text: lines.join("\n") };
}

it("keeps files raw and redacts console/tail independently", async () => {
  const secret = "sk-syntheticcredential123456";
  const meta = { password: "synthetic-password", count: 3 };
  const result = await logToSinks(`request failed token=${secret}`, structuredClone(meta));
  const tail = await expectMetadata(result, meta, { password: "***", count: 3 });
  expect(result.raw.message).toContain(secret);
  expect(JSON.stringify(result.console)).not.toContain(secret);
  expect(tail.text).not.toContain(secret);
});

it.each([
  { value: "private-value", pattern: "^private-value$" },
  { value: 42, pattern: '"value":(42)' },
  { value: true, pattern: '"value":(true)' },
  { value: null, pattern: '"value":(null)' },
])("redacts custom scalar at console/tail: $value", async ({ value, pattern }) => {
  const result = await logToSinks("custom rules", { value }, [pattern]);
  await expectMetadata(result, { value }, { value: "***" });
});

it("refreshes registry/custom policies without rewriting files", async () => {
  registerSecretValueForRedaction("987654321");
  const meta = { value: 987654321, nested: [987654321] };
  const result = await logToSinks("registry proof", structuredClone(meta));
  await expectMetadata(result, meta, { value: "***", nested: ["***"] });
  const reloaded = await logToSinks("reload proof", { value: "reload-private" }, [
    "^reload-private$",
  ]);
  await expectMetadata(reloaded, { value: "reload-private" }, { value: "***" });
});

it("writes valid raw overflow metadata and masks it when tailed", async () => {
  const hostname = '--token "synthetic-credential-123456"';
  vi.spyOn(os, "hostname").mockReturnValue(hostname);
  const result = await logToSinks("overflow", undefined, undefined, (logger, file) => {
    logger.info("first");
    for (let index = 0; index < 4_095; index += 1) {
      fileLogTransport.enqueue({ file, hostname, maxFileBytes: 1024 * 1024, payload: "{}\n" });
    }
    logger.info("second");
  });
  expect(result.raw).toMatchObject({ dropped: 1, hostname });
  const tail = await readTail(5_000);
  expect(tail.record.dropped).toBe(1);
  expect(tail.text).not.toContain("synthetic-credential-123456");
});

it("serializes native values once, preserving cycles, bigints and text", async () => {
  const toJSON = vi.fn(() => ({ token: "raw-native-token", count: 7 }));
  const circular: Record<string, unknown> = { count: 9n };
  circular.self = circular;
  const result = await logToSinks("native values", undefined, undefined, (logger) => {
    logger.info("native value", { toJSON }, circular, Number.NaN);
  });
  expect(toJSON).toHaveBeenCalledTimes(1);
  expect([result.raw["2"], result.raw["3"], result.raw.message]).toEqual([
    { token: "raw-native-token", count: 7 },
    { count: "9", self: "[Circular]" },
    'native value {"token":"raw-native-token","count":7} {"count":"9","self":"[Circular]"} NaN',
  ]);
  expect((await readTail()).text).not.toContain("raw-native-token");
});

it.each([
  { value: "private-value", pattern: "^private-value$" },
  { value: `private-value${"x".repeat(6000)}`, pattern: "^private-valuex+$" },
])("redacts complete and truncated display copies", async ({ value, pattern }) => {
  const result = await logToSinks("display projection", undefined, [pattern], (logger) => {
    logger.info("native value", { value, key: "opaque-key", password: 1234 });
  });
  expect(result.raw.message).toContain("private-value");
  const tail = await readTail();
  expect(tail.text).not.toContain("private-value");
  expect(tail.text).not.toContain("opaque-key");
  expect(tail.record["2"].password).toBe("***");
  expect(tail.record.message).not.toContain("1234");
});

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
it.each([
  ["root", getLogger],
  ["child", () => child()],
  ["nested child", () => child().getSubLogger({ name: "nested" })],
  ["pino child", () => toPinoLikeLogger(child(), "info").child({ component: "nested" })],
] as const)(
  "refreshes retained %s across silent, file and level changes",
  async (_name, create) => {
    const first = logPathTracker.nextPath();
    const second = logPathTracker.nextPath();
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
  const first = logPathTracker.nextPath();
  const second = logPathTracker.nextPath();
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
  const file = logPathTracker.nextPath();
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
  applyLoggingConfig({ level: "silent", file: logPathTracker.nextPath() });
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
  const file = logPathTracker.nextPath();
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

it("keeps falsy scalar context ahead of later aliases and logger bindings", async () => {
  const logger = getChildLogger({ agentId: "binding-agent", messageProvider: "binding-channel" });
  logger.info(
    { agent_id: 0, agentId: "later-agent", channel: false, messageProvider: "later-channel" },
    "context priority",
  );
  expect((await readRecords())[0]).toMatchObject({ agent_id: "0", channel: "false" });
});

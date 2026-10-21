// File logs preserve raw values; diagnostic emission owns its redaction.
import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { PluginStateStoreError } from "../plugin-state/plugin-state-store.types.js";
import {
  capturePluginStateWorkerFailure,
  restorePluginStateWorkerFailure,
} from "../plugin-state/plugin-state-worker-errors.js";
import { withEnv } from "../test-utils/env.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import {
  getChildLogger,
  getLogger,
  resetLogger,
  setLoggerOverride,
  toPinoLikeLogger,
} from "./logger.js";
import { testApi as loggerTest } from "./logger.test-support.js";
import { createDiagnosticLogRecordCapture } from "./test-helpers/diagnostic-log-capture.js";

const secret = "sk-testsecret1234567890abcd";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const logPathTracker = createSuiteLogPathTracker("openclaw-log-redaction-");
let logPath: string;

async function readLogFile(): Promise<string> {
  await loggerTest.flushFileLogQueueForTests();
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
  resetDiagnosticEventsForTest();
  logPath = logPathTracker.nextPath();
  setLoggerOverride({ level: "info", file: logPath });
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetLogger();
  vi.restoreAllMocks();
});

afterAll(() => logPathTracker.cleanup());
it.each([{ aggregate: false }, { aggregate: true }])(
  "retains plugin-state failure origin and raw causes (aggregate=$aggregate)",
  async ({ aggregate }) => {
    const native = Object.assign(new Error(`Permission denied; Authorization: Bearer ${secret}`), {
      code: "EACCES",
      errno: -13,
      privateData: "unrelated stored value",
    });
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
    expect(content).toContain(secret);
    expect((await readConfiguredLogTail()).lines.join("\n")).not.toContain(secret);
    expect(content).not.toContain("unrelated stored value");
    expect(record["1"].error).not.toHaveProperty("stack");
  },
);

it("redacts sensitive structured fields before emitting diagnostic log records", async () => {
  // afterEach owns diagnostic subscription cleanup, including this capture.
  const capture = createDiagnosticLogRecordCapture();
  getLogger().info(
    { password: "hunter2", token: "token-value-1234567890" },
    "credential diagnostic",
  );
  await capture.flush();
  const serialized = JSON.stringify(capture.records);
  expect(serialized).toContain("credential diagnostic");
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("token-value-1234567890");
  expect(capture.records.at(-1)?.attributes?.password).toBe("***");
});

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

import fs from "node:fs";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { loggingState } from "../logging/state.js";
import {
  formatForLog,
  logWs,
  summarizeAgentEventForWsLog,
  summarizeSessionListForWsLog,
} from "./ws-log.js";
import { setGatewayWsLogStyle } from "./ws-logging.js";

const logPaths = createSuiteLogPathTracker("openclaw-ws-log-");
beforeAll(() => logPaths.setup());
afterAll(() => logPaths.cleanup());

function captureConsole() {
  const output = vi.fn();
  loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
  return output;
}

function setLogStyle(style: "optimized" | "compact" | "full") {
  setVerbose(style !== "optimized");
  setGatewayWsLogStyle(style === "optimized" ? "auto" : style);
}

function timedTraffic(style: Parameters<typeof setLogStyle>[0], consoleLevel: "debug" | "info") {
  setLogStyle(style);
  setLoggerOverride({ level: "silent", consoleLevel });
  const output = captureConsole();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const frames: Array<{ connId: string; id: string; method: string }> = [];
  return {
    clock,
    request: (frame: (typeof frames)[number]) => {
      frames.push(frame);
      logWs("in", "req", frame);
    },
    respond: (frame: (typeof frames)[number], expected: string | false | null, ok = true) => {
      output.mockClear();
      logWs("out", "res", { ...frame, ok });
      if (expected === null) {
        expect(output).not.toHaveBeenCalled();
      } else {
        expect(output).toHaveBeenLastCalledWith(
          expected === false
            ? expect.not.stringMatching(/\d+ms/)
            : expect.stringContaining(expected),
        );
      }
    },
    [Symbol.dispose]() {
      setLogStyle(style);
      clock.mockReturnValue(1_000);
      for (const frame of frames) {
        logWs("out", "res", { ...frame, ok: true });
      }
    },
  };
}

function logPrivateEvent(payload: Parameters<typeof summarizeAgentEventForWsLog>[0]) {
  setLogStyle("full");
  setLoggerOverride({ level: "silent", consoleLevel: "info" });
  const output = captureConsole();
  const summary = summarizeAgentEventForWsLog(payload);
  logWs("out", "event", { event: "agent", ...summary });
  expect(output).toHaveBeenCalled();
  expect(JSON.stringify(output.mock.calls)).not.toContain("synthetic-private-content");
  return { summary, output };
}

function shouldLogWs(direction: "in" | "out", kind: string): boolean {
  let admitted = false;
  logWs(direction, kind, () => {
    admitted = true;
    return { connId: "matrix", id: `matrix-${kind}`, ok: true };
  });
  return admitted;
}

afterEach(() => {
  setVerbose(false);
  setGatewayWsLogStyle("auto");
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.restoreAllMocks();
});

test("keeps failures and one-second responses at info while retaining successful traffic at debug", async () => {
  const output = captureConsole();
  const clock = vi.spyOn(Date, "now");
  for (const level of ["info", "debug"] as const) {
    const file = logPaths.nextPath();
    resetLogger();
    setLoggerOverride({ level, consoleLevel: "info", file });
    output.mockClear();
    const respond = (id: string, elapsed: number, ok = true, bytes = 1) => {
      const frame = { connId: "log-levels", id, method: "sessions.list" };
      clock.mockReturnValue(10_000);
      logWs("in", "req", frame);
      clock.mockReturnValue(10_000 + elapsed);
      logWs("out", "res", {
        ...frame,
        ok,
        bytes,
        ...(!ok ? { errorMessage: "synthetic failure" } : {}),
      });
    };
    respond("fast", 0);
    respond("former-slow", 50);
    respond("large", 999, true, 300 * 1024);
    respond("slow", 1_000);
    respond("failure", 0, false);
    logWs("out", "res", { connId: "log-levels", id: "unmatched", method: "health", ok: true });
    logWs("out", "parse-error", { connId: "log-levels", error: "synthetic invalid frame" });
    await testApi.flushFileLogQueueForTests();
    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string; _meta: { logLevelName: string } });
    expect(output).toHaveBeenCalledTimes(3);
    expect(records.map((record) => record._meta.logLevelName)).toEqual(
      level === "info"
        ? ["INFO", "INFO", "WARN"]
        : ["DEBUG", "DEBUG", "DEBUG", "INFO", "INFO", "DEBUG", "WARN"],
    );
    expect(records.find((record) => record.message.includes("synthetic failure"))).toBeDefined();
    expect(records.find((record) => record.message.includes("1000ms"))).toBeDefined();
    if (level === "debug") {
      expect(records.find((record) => record.message.includes("bytes=307200"))).toBeDefined();
    }
  }
});

test.each([
  ["compact", "compact"],
  ["dashboard", "dashboard"],
  ["sidebar", "sidebar"],
  [undefined, "full"],
  ["unrecognized caller value", "full"],
])("reports session row mode %s as %s", (rowMode, expected) => {
  expect(summarizeSessionListForWsLog({ source: "sidebar", rowMode })).toMatchObject({
    source: "sidebar",
    rowMode: expected,
  });
});

test.each(["optimized", "compact", "full"] as const)(
  "preserves request identity across %s log changes",
  (style) => {
    using traffic = timedTraffic(style, "debug");
    const { clock, request, respond } = traffic;
    const first = { connId: `first-${style}`, id: "same", method: "health" };
    const second = { connId: `second-${style}`, id: "same", method: "health" };
    request(first);
    clock.mockReturnValue(1_050);
    request(second);
    clock.mockReturnValue(1_100);
    respond(first, "100ms");
    respond(second, "50ms");
    respond(first, false, false);

    clock.mockReturnValue(2_100);
    request(second);
    setVerbose(true);
    setGatewayWsLogStyle(style === "full" ? "compact" : "full");
    clock.mockReturnValue(2_200);
    respond(second, "100ms");
  },
);

test("evicts only the oldest unanswered request timings when the cap is exceeded", () => {
  using traffic = timedTraffic("optimized", "info");
  const { clock, request, respond } = traffic;
  const frame = (id: string) => ({ connId: "evict", id, method: "health" });
  for (let index = 0; index < 1_500; index += 1) {
    request(frame(`stale-${index}`));
  }
  request(frame("live"));
  for (let index = 0; index < 600; index += 1) {
    request(frame(`newer-${index}`));
  }
  clock.mockReturnValue(1_000 + 5_000);
  respond(frame("live"), "5000ms");
  respond(frame("newer-599"), "5000ms");
  // Exactly the 101 oldest entries were dropped to hold the 2000 bound.
  respond(frame("stale-0"), null);
  respond(frame("stale-100"), null);
  respond(frame("stale-101"), "5000ms");
});

test.each([
  ["silent", "info"],
  ["info", "warn"],
] as const)("admits useful optimized frames with file=%s console=%s", (level, consoleLevel) => {
  setVerbose(false);
  setLoggerOverride({ level, consoleLevel });
  expect(shouldLogWs("out", "event")).toBe(false);
  expect(shouldLogWs("in", "req")).toBe(true);
  expect(shouldLogWs("out", "res")).toBe(true);
  expect(shouldLogWs("out", "parse-error")).toBe(true);
  setVerbose(true);
  expect(shouldLogWs("out", "event")).toBe(true);
});

test.each([
  [
    "run ID prefix",
    { runId: `${"a".repeat(11)}🚀${"b".repeat(20)}` },
    "run",
    `${"a".repeat(11)}…bbbb`,
  ],
  [
    "tool-call ID suffix",
    { stream: "tool", data: { toolCallId: `${"a".repeat(25)}🚀bbb` } },
    "call",
    `${"a".repeat(12)}…bbb`,
  ],
] as const)("keeps the %s UTF-16 safe", (_name, payload, field, expected) => {
  const value = summarizeAgentEventForWsLog(payload)[field];
  expect(value).toBe(expected);
  expect(value).not.toMatch(/[\uD800-\uDFFF]/);
});

test("formatForLog walks cause chain so the underlying error is not hidden (openclaw-4a8)", () => {
  const root = Object.assign(new Error('"Method not found": nes/close (-32601)'), {
    name: "RequestError",
  });
  const wrapped = new Error("Agent does not support session/close (oneshot:abc)", {
    cause: root,
  });
  const top = Object.assign(new Error("ACP turn failed before completion.", { cause: wrapped }), {
    name: "AcpRuntimeError",
    code: "ACP_TURN_FAILED",
  });

  const out = formatForLog(top);

  expect(out).toMatch(/AcpRuntimeError/);
  expect(out).toMatch(/ACP_TURN_FAILED/);
  expect(out).toMatch(/Agent does not support session\/close/);
  expect(out).toMatch(/Method not found/);
  expect(out).toMatch(/nes\/close/);
  expect(out).toMatch(/-32601/);
});

test("formatForLog caps cause-chain depth so a self-referential cause cannot loop", () => {
  const e: Error & { cause?: unknown } = new Error("loop");
  e.cause = e;

  const out = formatForLog(e);

  expect(out).toMatch(/loop/);
  expect(out.length).toBeLessThan(2000);
});

test("formatForLog omits empty error segments without dropping a false cause", () => {
  const outer = new Error("", { cause: new Error("leaf", { cause: false }) });
  outer.name = "";
  expect(formatForLog(outer)).toBe("Error: leaf <- false");
});

const longText = `${"a".repeat(239)}😀tail`;
test.each([
  ["message and code", { name: "Oops", message: "failed", code: "E1" }, "Oops: failed: code=E1"],
  ["bounded string", longText, `${"a".repeat(239)}...`],
  ["bounded Error", Object.assign(new Error(longText), { name: "" }), `${"a".repeat(239)}...`],
  ["bounded message object", { message: longText }, `${"a".repeat(239)}...`],
])("formats %s safely", (_name, input, expected) => {
  expect(formatForLog(input)).toBe(expected);
});

test.each([
  ["incognito", "lifecycle", {}, null],
  ["regular", "assistant", { media: 2, textChars: 25 }, "textChars"],
  ["regular", "tool", { tool: "start:fetch", call: "12345678…9abc" }, "metaChars"],
  ["regular", "lifecycle", { phase: "abort", aborted: true, err: true }, null],
  ["regular", "compaction", { phase: "start", aborted: true, err: true, outcome: "failed" }, null],
] as const)("keeps %s %s events private", (scope, stream, expected, countField) => {
  const incognito = scope === "incognito";
  const marker = "synthetic-private-content";
  const privateData = { text: marker, meta: marker, error: marker, reason: marker };
  const { summary, output } = logPrivateEvent({
    runId: incognito ? "private-run" : "12345678-1234-1234-1234-123456789abc",
    sessionKey: incognito ? "agent:main:dashboard:incognito-synthetic" : "agent:main:thread-1",
    stream,
    seq: 2,
    data: incognito
      ? privateData
      : {
          ...privateData,
          outcome: "failed",
          aborted: true,
          phase: stream === "lifecycle" ? "abort" : "start",
          name: "fetch",
          toolCallId: "12345678-1234-1234-1234-123456789abc",
          mediaUrls: ["a", "b"],
        },
  });
  const expectedSummary = {
    run: incognito ? "private-run" : "12345678…9abc",
    agent: "main",
    session: incognito ? "dashboard:incognito-synthetic" : "thread-1",
    stream,
    aseq: 2,
    ...expected,
  };
  if (incognito) {
    expect(summary).toEqual(expectedSummary);
  } else {
    expect(summary).toMatchObject(expectedSummary);
  }
  expect(summary).not.toHaveProperty("text");
  expect(summary).not.toHaveProperty("error");
  if (countField) {
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining(`${countField}=25`));
  }
});

test("preserves invalid session keys and unknown-stream reasons", () => {
  const summary = summarizeAgentEventForWsLog({
    sessionKey: "bogus-session",
    stream: "other",
    data: { reason: "dropped" },
  });
  expect(summary).toEqual({ session: "bogus-session", stream: "other", reason: "dropped" });
});

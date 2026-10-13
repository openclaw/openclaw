/**
 * Gateway WebSocket log formatting tests.
 */
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
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

describe("gateway ws log helpers", () => {
  test("keeps failures and one-second responses at info while retaining successful traffic at debug", async () => {
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
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
    "bounds unanswered timing and preserves request identity across %s log changes",
    (style) => {
      setVerbose(style !== "optimized");
      setGatewayWsLogStyle(style === "optimized" ? "auto" : style);
      setLoggerOverride({ level: "silent", consoleLevel: "debug" });
      const output = vi.fn();
      loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const first = { connId: `first-${style}`, id: "same", method: "health" };
      const second = { connId: `second-${style}`, id: "same", method: "health" };
      try {
        logWs("in", "req", first);
        clock.mockReturnValue(1_050);
        logWs("in", "req", second);
        clock.mockReturnValue(1_100);
        output.mockClear();
        logWs("out", "res", { ...first, ok: true });
        expect(output).toHaveBeenLastCalledWith(expect.stringContaining("100ms"));
        logWs("out", "res", { ...second, ok: true });
        expect(output).toHaveBeenLastCalledWith(expect.stringContaining("50ms"));
        logWs("out", "res", { ...first, ok: false });
        expect(output).toHaveBeenLastCalledWith(expect.not.stringMatching(/\d+ms/));

        clock.mockReturnValue(2_000);
        logWs("in", "req", first);
        for (let index = 0; index < 2_000; index += 1) {
          logWs("in", "req", { ...first, id: `unanswered-${index}` });
        }
        clock.mockReturnValue(2_100);
        output.mockClear();
        logWs("out", "res", { ...first, ok: false });
        expect(output).toHaveBeenLastCalledWith(expect.not.stringMatching(/\d+ms/));

        logWs("in", "req", second);
        setVerbose(true);
        setGatewayWsLogStyle(style === "full" ? "compact" : "full");
        clock.mockReturnValue(2_200);
        logWs("out", "res", { ...second, ok: true });
        expect(output).toHaveBeenLastCalledWith(expect.stringContaining("100ms"));
      } finally {
        setVerbose(style !== "optimized");
        setGatewayWsLogStyle(style === "optimized" ? "auto" : style);
        logWs("out", "res", { ...first, ok: true });
        logWs("out", "res", { ...second, ok: true });
        for (let index = 0; index < 2_000; index += 1) {
          logWs("out", "res", { ...first, id: `unanswered-${index}`, ok: true });
        }
      }
    },
  );

  test("evicts only the oldest unanswered request timings when the cap is exceeded", () => {
    setVerbose(false);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const frame = (id: string) => ({ connId: "evict", id, method: "health" });
    const answer = (id: string) => {
      output.mockClear();
      logWs("out", "res", { ...frame(id), ok: true });
    };
    // Old requests that never get a response, then the request under test, then enough
    // newer ones to cross the cap.
    for (let index = 0; index < 1_500; index += 1) {
      logWs("in", "req", frame(`stale-${index}`));
    }
    logWs("in", "req", frame("live"));
    for (let index = 0; index < 600; index += 1) {
      logWs("in", "req", frame(`newer-${index}`));
    }
    clock.mockReturnValue(1_000 + 5_000);
    try {
      // The request that was in flight when the cap tripped keeps its slow-response timing.
      answer("live");
      expect(output).toHaveBeenLastCalledWith(expect.stringContaining("5000ms"));
      answer("newer-599");
      expect(output).toHaveBeenLastCalledWith(expect.stringContaining("5000ms"));
      // Exactly the 101 oldest entries were dropped to hold the 2000 bound.
      answer("stale-0");
      expect(output).not.toHaveBeenCalled();
      answer("stale-100");
      expect(output).not.toHaveBeenCalled();
      answer("stale-101");
      expect(output).toHaveBeenLastCalledWith(expect.stringContaining("5000ms"));
    } finally {
      clock.mockReturnValue(1_000);
      for (let index = 0; index < 1_500; index += 1) {
        logWs("out", "res", { ...frame(`stale-${index}`), ok: true });
      }
      for (let index = 0; index < 600; index += 1) {
        logWs("out", "res", { ...frame(`newer-${index}`), ok: true });
      }
    }
  });

  test("admits only useful optimized-mode frames and honors console info enablement", () => {
    setVerbose(false);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });

    expect(shouldLogWs("out", "event")).toBe(false);
    expect(shouldLogWs("in", "req")).toBe(true);
    expect(shouldLogWs("out", "res")).toBe(true);
    expect(shouldLogWs("out", "parse-error")).toBe(true);

    setVerbose(true);
    expect(shouldLogWs("out", "event")).toBe(true);

    setVerbose(false);
    setLoggerOverride({ level: "info", consoleLevel: "warn" });
    expect(shouldLogWs("in", "req")).toBe(true);
    expect(shouldLogWs("out", "res")).toBe(true);
    expect(shouldLogWs("out", "parse-error")).toBe(true);
    expect(shouldLogWs("out", "event")).toBe(false);

    setVerbose(true);
    expect(shouldLogWs("out", "event")).toBe(true);
  });

  test.each([
    {
      name: "run ID prefix boundary",
      payload: { runId: `${"a".repeat(11)}🚀${"b".repeat(20)}` },
      field: "run",
      expected: `${"a".repeat(11)}…bbbb`,
    },
    {
      name: "tool-call ID suffix boundary",
      payload: {
        stream: "tool",
        data: { toolCallId: `${"a".repeat(25)}🚀bbb` },
      },
      field: "call",
      expected: `${"a".repeat(12)}…bbb`,
    },
  ])("summarizeAgentEventForWsLog keeps the $name UTF-16 safe", ({ payload, field, expected }) => {
    const value = summarizeAgentEventForWsLog(payload)[field];

    expect(value).toBe(expected);
    expect(value).not.toMatch(/[\uD800-\uDFFF]/);
  });

  test.each([
    {
      name: "formats message-like objects with codes",
      input: { name: "Oops", message: "failed", code: "E1" },
      expected: "Oops: failed: code=E1",
    },
  ])("formatForLog $name", ({ input, expected }) => {
    expect(formatForLog(input)).toBe(expected);
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

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test.each([
    ["string", `${"a".repeat(239)}😀tail`],
    ["Error", Object.assign(new Error(`${"a".repeat(239)}😀tail`), { name: "" })],
    ["message-like object", { message: `${"a".repeat(239)}😀tail` }],
  ])("formatForLog keeps bounded %s values UTF-16 safe", (_name, input) => {
    expect(formatForLog(input)).toBe(`${"a".repeat(239)}...`);
  });

  test.each(["lifecycle"])(
    "keeps Incognito %s content out of verbose event logs while retaining routing metadata",
    (stream) => {
      setVerbose(true);
      setGatewayWsLogStyle("full");
      setLoggerOverride({ level: "silent", consoleLevel: "info" });
      const output = vi.fn();
      loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
      const marker = "synthetic-private-content";
      const summary = summarizeAgentEventForWsLog({
        runId: "private-run",
        sessionKey: "agent:main:dashboard:incognito-synthetic",
        stream,
        seq: 2,
        data: { text: marker, meta: marker, error: marker, reason: marker },
      });
      logWs("out", "event", { event: "agent", ...summary });
      expect(output).toHaveBeenCalled();
      expect(JSON.stringify(output.mock.calls)).not.toContain(marker);
      expect(summary).toEqual({
        run: "private-run",
        agent: "main",
        session: "dashboard:incognito-synthetic",
        stream,
        aseq: 2,
      });
    },
  );

  test.each(["assistant", "tool"])("keeps %s content out of verbose event logs", (stream) => {
    setVerbose(true);
    setGatewayWsLogStyle("full");
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const output = vi.fn();
    loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
    const marker = "synthetic-private-content";
    const summary = summarizeAgentEventForWsLog({
      runId: "12345678-1234-1234-1234-123456789abc",
      sessionKey: "agent:main:thread-1",
      stream,
      seq: 2,
      data: {
        text: marker,
        meta: marker,
        phase: "start",
        name: "fetch",
        toolCallId: "12345678-1234-1234-1234-123456789abc",
        mediaUrls: ["a", "b"],
      },
    });

    logWs("out", "event", { event: "agent", ...summary });

    expect(output).toHaveBeenCalled();
    expect(JSON.stringify(output.mock.calls)).not.toContain(marker);
    expect(summary).toMatchObject({
      run: "12345678…9abc",
      agent: "main",
      session: "thread-1",
      stream,
      aseq: 2,
      ...(stream === "assistant"
        ? { media: 2, textChars: 25 }
        : { tool: "start:fetch", call: "12345678…9abc" }),
    });
    expect(summary).not.toHaveProperty("text");
    expect(output).toHaveBeenLastCalledWith(
      expect.stringContaining(`${stream === "assistant" ? "textChars" : "metaChars"}=25`),
    );
  });

  test("summarizeAgentEventForWsLog includes lifecycle errors with compact previews", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "run-2",
      sessionKey: "agent:main:thread-1",
      stream: "lifecycle",
      data: {
        phase: "abort",
        aborted: true,
        error: "fatal ".repeat(40),
      },
    });

    expect(summary.agent).toBe("main");
    expect(summary.session).toBe("thread-1");
    expect(summary.stream).toBe("lifecycle");
    expect(summary.phase).toBe("abort");
    expect(summary.aborted).toBe(true);
    expect(summary.error).toBeTypeOf("string");
    expect((summary.error as string).length).toBeLessThanOrEqual(120);
  });

  test("summarizeAgentEventForWsLog preserves invalid session keys and unknown-stream reasons", () => {
    expect(
      summarizeAgentEventForWsLog({
        sessionKey: "bogus-session",
        stream: "other",
        data: { reason: "dropped" },
      }),
    ).toEqual({
      session: "bogus-session",
      stream: "other",
      reason: "dropped",
    });
  });
});

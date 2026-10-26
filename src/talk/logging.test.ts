import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { recordTalkObservabilityEvent as observe } from "./observability.js";
import { createTalkEventSequencer } from "./talk-events.js";

const context = {
  sessionId: "talk-session",
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  provider: "openai",
} as const;
const diagnostics = vi.fn<Parameters<typeof onInternalDiagnosticEvent>[0]>();
let tmpDir: string, logFile: string, unsubscribe: () => void;
const record = (input: Parameters<ReturnType<typeof createTalkEventSequencer>["next"]>[0]) =>
  observe(createTalkEventSequencer(context).next(input));
const expectPrivateFieldsAbsent = (text: string) =>
  expect(text).not.toMatch(/private transcript|turn-1|call-1|item-1/u);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-talk-logs-"));
  logFile = path.join(tmpDir, "openclaw.log");
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info", file: logFile });
  diagnostics.mockClear();
  unsubscribe = onInternalDiagnosticEvent(diagnostics);
});
afterEach(async () => {
  await flushLogger();
  unsubscribe();
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// diagnostics.test.ts owns the complete diagnostic envelope; this suite owns log egress.
it("emits bounded lifecycle log records without transcript text or scoped ids", async () => {
  record({
    type: "output.text.done",
    turnId: "turn-1",
    callId: "call-1",
    itemId: "item-1",
    final: true,
    payload: { text: "private transcript should not be logged", durationMs: 42 },
  });
  await setImmediate();
  const logs = diagnostics.mock.calls.filter(([event]) => event.type === "log.record");
  expect(logs).toHaveLength(1);
  expect(logs[0]?.[0]).toMatchObject({
    level: "INFO",
    message: "talk event output.text.done",
    attributes: {
      subsystem: "talk",
      sessionId: "talk-session",
      talkEventType: "output.text.done",
      talkMode: "realtime",
      talkTransport: "gateway-relay",
      talkBrain: "agent-consult",
      talkProvider: "openai",
      talkFinal: true,
      talkDurationMs: 42,
    },
  });
  expectPrivateFieldsAbsent(JSON.stringify(logs));
  await flushLogger();
  const fileLog = fs.readFileSync(logFile, "utf8");
  const records = fileLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.filter((entry) => entry["0"] === '{"subsystem":"talk"}')).toEqual([
    expect.objectContaining({ message: "talk event output.text.done", session_id: "talk-session" }),
  ]);
  expectPrivateFieldsAbsent(fileLog);
});

it("drops high-volume delta records from file and OTLP logs", async () => {
  record({
    type: "transcript.delta",
    turnId: "turn-1",
    payload: { text: "private partial transcript" },
  });
  record({ type: "output.audio.delta", turnId: "turn-1", payload: { byteLength: 320 } });
  await setImmediate();
  expect(diagnostics.mock.calls.filter(([event]) => event.type === "log.record")).toEqual([]);
});

it("records diagnostics and warning logs with separate trust classifications", async () => {
  record({ type: "session.error", payload: { message: "private detail" }, final: true });
  await setImmediate();
  expect(diagnostics).toHaveBeenCalledTimes(2);
  expect(diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "talk.event",
      ...context,
      talkEventType: "session.error",
      final: true,
    }),
    expect.objectContaining({ trusted: true }),
  );
  expect(diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "log.record",
      level: "WARN",
      message: "talk event session.error",
      attributes: expect.objectContaining({ talkFinal: true, talkEventType: "session.error" }),
    }),
    expect.objectContaining({ trusted: false }),
  );
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private detail");
});

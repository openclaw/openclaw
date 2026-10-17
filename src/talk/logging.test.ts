import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { flushLogger, getChildLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { recordTalkLogEvent } from "./logging.js";
import { recordTalkObservabilityEvent as observe } from "./observability.js";
import { createTalkEventSequencer } from "./talk-events.js";

const TALK_CONTEXT = {
  sessionId: "talk-session",
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  provider: "openai",
} as const;

type LogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;
type ObservedDiagnostic<T extends DiagnosticEventPayload = DiagnosticEventPayload> = {
  event: T;
  trusted: boolean;
};

function stableDiagnosticPayload(event: DiagnosticEventPayload) {
  expect(event.seq).toBeGreaterThan(0);
  expect(event.ts).toBeGreaterThan(0);
  const { seq: _seq, ts: _ts, trace, ...stable } = event;
  expect(trace).toBeUndefined();
  if (stable.type !== "log.record") {
    return stable;
  }
  const { code, loggerParents, ...record } = stable;
  expect(loggerParents).toStrictEqual(["openclaw"]);
  expect(code?.functionName).toMatch(/^[A-Za-z0-9_.:-]+$/u);
  expect(code?.line).toBeGreaterThan(0);
  return record;
}

let tmpDir: string;
let logFile: string;
let observed: ObservedDiagnostic[];
let unsubscribe: () => void;
const logs = () => observed.flatMap(({ event }) => (event.type === "log.record" ? [event] : []));
const next = (input: Parameters<ReturnType<typeof createTalkEventSequencer>["next"]>[0]) =>
  createTalkEventSequencer(TALK_CONTEXT).next(input);
const record = (input: Parameters<typeof next>[0], hook = recordTalkLogEvent) => hook(next(input));
async function collect() {
  await setImmediate();
  unsubscribe();
}
const diagnostic = <T extends DiagnosticEventPayload["type"]>(type: T) =>
  expectDefined(
    observed.find(
      (entry): entry is ObservedDiagnostic<Extract<DiagnosticEventPayload, { type: T }>> =>
        entry.event.type === type,
    ),
    `Expected ${type} diagnostic event`,
  );

function expectLog(event: LogRecord, type: string, level: string, extra = {}) {
  expect(stableDiagnosticPayload(event)).toStrictEqual({
    type: "log.record",
    level,
    message: `talk event ${type}`,
    attributes: {
      subsystem: "talk",
      sessionId: "talk-session",
      talkEventType: type,
      talkMode: "realtime",
      talkTransport: "gateway-relay",
      talkBrain: "agent-consult",
      talkProvider: "openai",
      talkFinal: true,
      ...extra,
    },
  });
}
function expectPrivateFieldsAbsent(serialized: string) {
  expect(serialized).not.toMatch(/private transcript|turn-1|call-1|item-1/u);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-talk-logs-"));
  logFile = path.join(tmpDir, "openclaw.log");
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info", file: logFile });
  observed = [];
  unsubscribe = onInternalDiagnosticEvent((event, { trusted }) =>
    observed.push({ event, trusted }),
  );
});

afterEach(async () => {
  await flushLogger();
  unsubscribe();
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it("emits bounded lifecycle log records without transcript text or scoped ids", async () => {
  record({
    type: "output.text.done",
    turnId: "turn-1",
    callId: "call-1",
    itemId: "item-1",
    final: true,
    payload: { text: "private transcript should not be logged", durationMs: 42 },
  });
  await collect();

  expect(logs()).toHaveLength(1);
  expectLog(expectDefined(logs()[0], "Talk diagnostic log"), "output.text.done", "INFO", {
    talkDurationMs: 42,
  });
  expectPrivateFieldsAbsent(JSON.stringify(logs()[0]));

  getChildLogger({ subsystem: "sibling" }).info("unrelated lifecycle event");
  await flushLogger();
  const fileLog = fs.readFileSync(logFile, "utf8");
  const fileLogRecords = fileLog
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const talkRecords = fileLogRecords.filter((entry) => entry["0"] === '{"subsystem":"talk"}');
  expect(talkRecords).toHaveLength(1);
  expect(expectDefined(talkRecords[0], "Talk file log record")).toMatchObject({
    message: "talk event output.text.done",
    session_id: "talk-session",
  });
  expect(fileLogRecords).toContainEqual(
    expect.objectContaining({ message: "unrelated lifecycle event" }),
  );
  expectPrivateFieldsAbsent(fileLog);
});

it("drops high-volume delta records from file and OTLP logs", async () => {
  record({
    type: "transcript.delta",
    turnId: "turn-1",
    payload: { text: "private partial transcript" },
  });
  record({ type: "output.audio.delta", turnId: "turn-1", payload: { byteLength: 320 } });
  await collect();
  expect(logs()).toHaveLength(0);
});

it("records diagnostics and logs through the combined observability hook", async () => {
  record({ type: "session.error", payload: { message: "private detail" }, final: true }, observe);
  await collect();

  expect(observed).toHaveLength(2);
  const talkEvent = diagnostic("talk.event");
  const logRecord = diagnostic("log.record");
  expect([talkEvent.trusted, logRecord.trusted]).toEqual([true, false]);
  expect(stableDiagnosticPayload(talkEvent.event)).toStrictEqual({
    type: "talk.event",
    ...TALK_CONTEXT,
    turnId: undefined,
    captureId: undefined,
    talkEventType: "session.error",
    final: true,
    durationMs: undefined,
    byteLength: undefined,
  });
  expectLog(logRecord.event, "session.error", "WARN");
  expect(JSON.stringify(observed)).not.toContain("private detail");
});

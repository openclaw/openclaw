import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { cronRunLogEntryFromEvent } from "./run-event-codec.js";
import {
  cronQuietTriggerDetail,
  cronRunLogEntryToDetail,
  cronRunRecordToRunLogEntry,
  cronRunRecordToTriggerEval,
  parseCronRunLogEntryObject,
  parseCronRunDetailJson,
} from "./run-history-detail.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronRunRecord } from "./store/run-history.types.js";
const BASE = { ts: 100, jobId: "history-job", action: "finished" } as const;

it.each([
  { outcome: "no_change" },
  { outcome: "blocked", summary: "Awaiting the requested approval." },
] as const)("round-trips structured $outcome through event and persisted history", (result) => {
  const entry = cronRunLogEntryFromEvent(
    { jobId: BASE.jobId, action: "finished", status: "ok", result },
    100,
    undefined,
  );
  expect(entry.result).toEqual(result);
  expect(cronRunRecordToRunLogEntry(recordFromEntry(entry))?.result).toEqual(result);
});
const parse = (fields: object) => parseCronRunLogEntryObject({ ...BASE, ...fields });
const undefinedFields = (keys: string) =>
  Object.fromEntries(keys.split(" ").map((key) => [key, undefined]));
function recordFromEntry(entry: CronRunLogEntry, storeKey = "/internal/cron/store"): CronRunRecord {
  return {
    id: "1",
    jobId: entry.jobId,
    createdAt: entry.runAtMs ?? entry.ts,
    endedAt: entry.ts,
    status: "succeeded",
    error: entry.error,
    summary: entry.summary,
    sessionKey: entry.sessionKey,
    detail: cronRunLogEntryToDetail(entry, { storeKey }),
  };
}
it.each([
  ["{", undefined],
  ["null", null],
  ['[1,{"state":[true,null,"retained"]}]', [1, { state: [true, null, "retained"] }]],
  ['{"overflow":1e400}', { overflow: Infinity }],
] as const)("preserves stored JSON semantics for %s", (serialized, expected) => {
  expect(parseCronRunDetailJson(serialized)).toEqual(expected);
});

it("allowlists legacy wire fields and retains row fallbacks", () => {
  const record = recordFromEntry({ ...BASE, status: "ok" });
  record.error = "legacy error";
  record.summary = "legacy summary";
  record.detail = {
    kind: "cron-run",
    status: "skipped",
    sessionId: "old-generation",
    storeKey: "/internal/cron/store",
    internalFutureField: "secret",
    triggerState: { secret: true },
    delivery: "malformed",
    failureNotificationDelivery: { status: "invalid", internal: "secret" },
  };
  Object.freeze(record.detail);
  Object.freeze(record);
  const entry = cronRunRecordToRunLogEntry(record);
  expect(entry).toMatchObject({
    status: "skipped",
    sessionId: "old-generation",
    error: "legacy error",
    summary: "legacy summary",
  });
  for (const key of ["delivered", "deliveryStatus", "deliveryError", "sessionId", "sessionKey"]) {
    expect(Object.hasOwn(entry ?? {}, key)).toBe(true);
  }
  for (const key of ["storeKey", "internalFutureField", "triggerState"]) {
    expect(Object.hasOwn(entry ?? {}, key)).toBe(false);
  }
  expect(entry?.delivery).toBeUndefined();
  expect(entry?.failureNotificationDelivery).toBeUndefined();
});

it.each([
  ["ok", "delivered", "succeeded"],
  ["ok", "not-delivered", "unknown"],
] as const)("derives legacy %s/%s completion as %s", (status, deliveryStatus, expected) => {
  expect(parse({ status, completionStatus: "partial", deliveryStatus })?.completionStatus).toBe(
    expected,
  );
});

it("keeps quiet-trigger recovery detail out of run history", () => {
  const record = recordFromEntry({ ...BASE, status: "ok" });
  const evaluation = { fired: false, stateChanged: true, state: { ready: false } } as const;
  record.detail = cronQuietTriggerDetail("/internal/cron/store", evaluation);
  expect(cronRunRecordToTriggerEval(record)).toEqual(evaluation);
  expect(cronRunRecordToRunLogEntry(record)).toBeNull();
});

it.each([
  ["absent", {}, "", ""],
  [
    "populated",
    {
      delivered: false,
      deliveryStatus: "not-delivered",
      deliveryError: "",
      deliverySuppressionReason: "channel_transform",
      failureNotificationDelivery: { delivered: true, status: "delivered", error: "" },
      delivery: { intended: { channel: "telegram", to: "123" } },
      sessionId: "session-1",
      sessionKey: "agent:main:cron:history-job",
    },
    ',"delivered":false,"deliveryStatus":"not-delivered","deliveryError":"","deliverySuppressionReason":"channel_transform","failureNotificationDelivery":{"status":"delivered","delivered":true,"error":""},"delivery":{"intended":{"channel":"telegram","to":"123"}},"sessionId":"session-1","sessionKey":"agent:main:cron:history-job"',
    ',"delivered":false,"deliveryStatus":"not-delivered","deliveryError":"","deliverySuppressionReason":"channel_transform","failureNotificationDelivery":{"status":"delivered","delivered":true,"error":""},"delivery":{"intended":{"channel":"telegram","to":"123"}},"sessionId":"session-1"',
  ],
] as const)(
  "preserves retained JSON bytes with %s optional fields",
  (_, fields, wireFields, detailFields) => {
    const entry = parse({ status: "error", internalFutureField: "discard", ...fields });
    if (!entry) {
      throw new Error("Expected a valid legacy run-history entry");
    }
    const wire = `{"ts":100,"jobId":"history-job","action":"finished","status":"error","completionStatus":"failed"${wireFields}}`;
    expect(JSON.stringify(entry)).toBe(wire);
    const record = recordFromEntry(entry, "cron-store");
    expect(JSON.stringify(record.detail)).toBe(
      `{"kind":"cron-run","status":"error","completionStatus":"failed","error":null,"summary":null,"storeKey":"cron-store"${detailFields}}`,
    );
    expect(JSON.stringify(cronRunRecordToRunLogEntry(record))).toBe(wire);
  },
);

it("preserves prepared failure reasons through history storage", () => {
  const entry = cronRunLogEntryFromEvent(
    {
      jobId: BASE.jobId,
      action: "finished",
      status: "error",
      error: "upstream unavailable: 503 overloaded",
      provider: "anthropic",
    },
    1,
    "overloaded",
  );
  expect(entry.errorReason).toBe("overloaded");
  expect(parseCronRunLogEntryObject(entry)?.errorReason).toBe("overloaded");
  expect(parse({ ...entry, errorReason: "not-a-real-reason" })?.errorReason).toBeUndefined();
});

it("rejects invalid legacy run-history scalar and timestamp fields", () => {
  expect(
    parse({
      status: "invalid",
      summary: 42,
      runAtMs: -1,
      durationMs: 1.5,
      nextRunAtMs: MAX_DATE_TIMESTAMP_MS + 1,
      delivery: [],
      usage: { input_tokens: Number.NaN, output_tokens: -1 },
    }),
  ).toEqual({
    ...BASE,
    completionStatus: "unknown",
    ...undefinedFields(
      "status error errorReason summary runId diagnostics runAtMs durationMs nextRunAtMs triggerFired model provider usage",
    ),
  });
  expect(parse({ usage: [] })?.usage).toBeUndefined();
  expect(parse({ usage: { input_tokens: 0, future_tokens: 1 } })?.usage).toEqual({
    input_tokens: 0,
    ...undefinedFields("output_tokens total_tokens cache_read_tokens cache_write_tokens"),
  });
  expect(parse({ usage: { future_tokens: 1 } })?.usage).toBeUndefined();
  expect(parse({ ts: MAX_DATE_TIMESTAMP_MS })).not.toBeNull();
  expect(parse({ ts: MAX_DATE_TIMESTAMP_MS + 1 })).toBeNull();
});

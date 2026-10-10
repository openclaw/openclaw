import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
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
const JOB_ID = "history-job";
function recordFromEntry(entry: CronRunLogEntry, index: number, storeKey: string): CronRunRecord {
  return {
    id: String(index),
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
describe("cron history wire codec", () => {
  it.each([
    { serialized: "{", expected: undefined },
    { serialized: "null", expected: null },
    {
      serialized: '[1,{"state":[true,null,"retained"]}]',
      expected: [1, { state: [true, null, "retained"] }],
    },
    { serialized: '{"overflow":1e400}', expected: { overflow: Infinity } },
  ])("preserves stored JSON semantics for $serialized", ({ serialized, expected }) => {
    expect(parseCronRunDetailJson(serialized)).toEqual(expected);
  });

  it("allowlists legacy wire fields and retains row fallbacks", () => {
    const storeKey = "/internal/cron/store";
    const record = recordFromEntry(
      { ts: 100, jobId: JOB_ID, action: "finished", status: "ok" },
      1,
      storeKey,
    );
    record.error = "legacy error";
    record.summary = "legacy summary";
    record.detail = {
      kind: "cron-run",
      status: "skipped",
      sessionId: "old-generation",
      storeKey,
      internalFutureField: "secret",
      triggerState: { secret: true },
      delivery: "malformed",
      failureNotificationDelivery: { status: "invalid", internal: "secret" },
    };
    Object.freeze(record.detail);
    Object.freeze(record);
    const entry = cronRunRecordToRunLogEntry(record);
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe("skipped");
    expect(entry?.sessionId).toBe("old-generation");
    for (const key of ["delivered", "deliveryStatus", "deliveryError", "sessionId", "sessionKey"]) {
      expect(Object.hasOwn(entry ?? {}, key)).toBe(true);
    }
    expect(Object.hasOwn(entry ?? {}, "storeKey")).toBe(false);
    expect(Object.hasOwn(entry ?? {}, "internalFutureField")).toBe(false);
    expect(Object.hasOwn(entry ?? {}, "triggerState")).toBe(false);
    expect(entry).toMatchObject({ error: "legacy error", summary: "legacy summary" });
    expect(entry?.delivery).toBeUndefined();
    expect(entry?.failureNotificationDelivery).toBeUndefined();
  });

  it.each([
    { status: "error", delivered: undefined, deliveryStatus: undefined, expected: "failed" },
    { status: "ok", delivered: undefined, deliveryStatus: "delivered", expected: "succeeded" },
    { status: "ok", delivered: true, deliveryStatus: undefined, expected: "succeeded" },
    { status: "ok", delivered: undefined, deliveryStatus: "not-requested", expected: "succeeded" },
    { status: "ok", delivered: undefined, deliveryStatus: "not-delivered", expected: "unknown" },
  ] as const)(
    "derives legacy $status/$deliveryStatus completion as $expected",
    ({ status, delivered, deliveryStatus, expected }) => {
      expect(
        parseCronRunLogEntryObject({
          ts: 100,
          jobId: JOB_ID,
          action: "finished",
          status,
          completionStatus: "partial",
          ...(delivered === undefined ? {} : { delivered }),
          ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
        })?.completionStatus,
      ).toBe(expected);
    },
  );

  it("keeps quiet-trigger recovery detail out of run history", () => {
    const record = recordFromEntry(
      { ts: 100, jobId: JOB_ID, action: "finished", status: "ok" },
      1,
      "/internal/cron/store",
    );
    record.detail = cronQuietTriggerDetail("/internal/cron/store", {
      fired: false,
      stateChanged: true,
      state: { ready: false },
    });

    expect(cronRunRecordToTriggerEval(record)).toEqual({
      fired: false,
      stateChanged: true,
      state: { ready: false },
    });
    expect(cronRunRecordToRunLogEntry(record)).toBeNull();
  });

  it.each([
    {
      name: "absent optional fields",
      fields: {},
      wireFields: "",
      detailFields: "",
    },
    {
      name: "populated optional fields",
      fields: {
        delivered: false,
        deliveryStatus: "not-delivered",
        deliveryError: "",
        deliverySuppressionReason: "channel_transform",
        failureNotificationDelivery: { delivered: true, status: "delivered", error: "" },
        delivery: { intended: { channel: "telegram", to: "123" } },
        sessionId: "session-1",
        sessionKey: "agent:main:cron:history-job",
      },
      wireFields:
        ',"delivered":false,"deliveryStatus":"not-delivered","deliveryError":"","deliverySuppressionReason":"channel_transform","failureNotificationDelivery":{"status":"delivered","delivered":true,"error":""},"delivery":{"intended":{"channel":"telegram","to":"123"}},"sessionId":"session-1","sessionKey":"agent:main:cron:history-job"',
      detailFields:
        ',"delivered":false,"deliveryStatus":"not-delivered","deliveryError":"","deliverySuppressionReason":"channel_transform","failureNotificationDelivery":{"status":"delivered","delivered":true,"error":""},"delivery":{"intended":{"channel":"telegram","to":"123"}},"sessionId":"session-1"',
    },
  ])("preserves retained JSON bytes with $name", ({ fields, wireFields, detailFields }) => {
    const entry = parseCronRunLogEntryObject({
      ts: 100,
      jobId: JOB_ID,
      action: "finished",
      status: "error",
      internalFutureField: "discard",
      ...fields,
    });
    if (!entry) {
      throw new Error("Expected a valid legacy run-history entry");
    }
    const wire =
      '{"ts":100,"jobId":"history-job","action":"finished","status":"error","completionStatus":"failed"' +
      wireFields +
      "}";
    expect(JSON.stringify(entry)).toBe(wire);
    const record = recordFromEntry(entry, 1, "cron-store");
    expect(JSON.stringify(record.detail)).toBe(
      '{"kind":"cron-run","status":"error","completionStatus":"failed","error":null,"summary":null,"storeKey":"cron-store"' +
        detailFields +
        "}",
    );
    expect(JSON.stringify(cronRunRecordToRunLogEntry(record))).toBe(wire);
  });

  it("authors failure reasons on write and trusts stored values on read", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: JOB_ID,
        action: "finished",
        status: "error",
        error: "upstream unavailable: 503 overloaded",
        provider: "anthropic",
      },
      1,
    );
    expect(entry.errorReason).toBe("overloaded");
    expect(parseCronRunLogEntryObject(entry)?.errorReason).toBe("overloaded");
    expect(
      parseCronRunLogEntryObject({
        ...entry,
        errorReason: "not-a-real-reason",
      })?.errorReason,
    ).toBeUndefined();
  });

  it("rejects invalid legacy run-history scalar and timestamp fields", () => {
    const base = { ts: 100, jobId: JOB_ID, action: "finished" } as const;
    expect(
      parseCronRunLogEntryObject({
        ...base,
        status: "invalid",
        summary: 42,
        runAtMs: -1,
        durationMs: 1.5,
        nextRunAtMs: MAX_DATE_TIMESTAMP_MS + 1,
        delivery: [],
        usage: { input_tokens: Number.NaN, output_tokens: -1 },
      }),
    ).toEqual({
      ...base,
      status: undefined,
      completionStatus: "unknown",
      error: undefined,
      errorReason: undefined,
      summary: undefined,
      runId: undefined,
      diagnostics: undefined,
      runAtMs: undefined,
      durationMs: undefined,
      nextRunAtMs: undefined,
      triggerFired: undefined,
      model: undefined,
      provider: undefined,
      usage: undefined,
    });
    expect(parseCronRunLogEntryObject({ ...base, usage: [] })?.usage).toBeUndefined();
    expect(
      parseCronRunLogEntryObject({ ...base, usage: { input_tokens: 0, future_tokens: 1 } })?.usage,
    ).toEqual({
      input_tokens: 0,
      output_tokens: undefined,
      total_tokens: undefined,
      cache_read_tokens: undefined,
      cache_write_tokens: undefined,
    });
    expect(
      parseCronRunLogEntryObject({ ...base, usage: { future_tokens: 1 } })?.usage,
    ).toBeUndefined();
    expect(parseCronRunLogEntryObject({ ...base, ts: MAX_DATE_TIMESTAMP_MS })).not.toBeNull();
    expect(parseCronRunLogEntryObject({ ...base, ts: MAX_DATE_TIMESTAMP_MS + 1 })).toBeNull();
  });
});

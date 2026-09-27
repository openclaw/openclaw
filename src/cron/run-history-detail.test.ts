import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { FAILOVER_REASONS } from "../../packages/gateway-protocol/src/failover-reasons.js";
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
    { serialized: "undefined", expected: undefined },
    { serialized: "null", expected: null },
    { serialized: "false", expected: false },
    { serialized: "0", expected: 0 },
    { serialized: '"retained"', expected: "retained" },
    { serialized: '[1,{"state":[true,null]}]', expected: [1, { state: [true, null] }] },
    { serialized: '{"overflow":1e400}', expected: { overflow: Infinity } },
  ])("preserves stored JSON semantics for $serialized", ({ serialized, expected }) => {
    expect(parseCronRunDetailJson(serialized)).toEqual(expected);
  });

  it.each([
    { status: "ok", expectedStatus: "ok" },
    { status: "error", expectedStatus: "error" },
    { status: "skipped", expectedStatus: "skipped" },
    { status: "invalid", expectedStatus: undefined },
    { status: null, expectedStatus: undefined },
    { status: undefined, expectedStatus: undefined },
  ])("allowlists the legacy wire record with status $status", ({ status, expectedStatus }) => {
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
      ...(status === undefined ? {} : { status }),
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
    expect(entry?.status).toBe(expectedStatus);
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
    { status: "ok", delivered: undefined, deliveryStatus: "unknown", expected: "unknown" },
    { status: "ok", delivered: undefined, deliveryStatus: undefined, expected: "unknown" },
  ] as const)(
    "derives legacy $status/$deliveryStatus completion as $expected",
    ({ status, delivered, deliveryStatus, expected }) => {
      expect(
        parseCronRunLogEntryObject({
          ts: 100,
          jobId: JOB_ID,
          action: "finished",
          status,
          ...(delivered === undefined ? {} : { delivered }),
          ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
        })?.completionStatus,
      ).toBe(expected);
    },
  );

  it("normalizes invalid completion status from immutable stored facts", () => {
    expect(
      parseCronRunLogEntryObject({
        ts: 100,
        jobId: JOB_ID,
        action: "finished",
        status: "ok",
        deliveryStatus: "not-delivered",
        completionStatus: "partial",
      })?.completionStatus,
    ).toBe("unknown");
  });

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

  it("locks the serialized detail shape: kind first, status second", () => {
    // External tooling may prefix-match serialized detail; keep the codec's
    // field order stable so those prefixes stay meaningful.
    for (const status of ["ok", "error", "skipped"] as const) {
      const detail = cronRunLogEntryToDetail(
        {
          ts: 100,
          jobId: JOB_ID,
          action: "finished",
          status,
        },
        { storeKey: "/tmp/cron-history" },
      );
      const serialized = JSON.stringify(detail);
      expect(
        serialized.startsWith(`{"kind":"cron-run","status":"${status}"`),
        `detail for status "${status}" must keep the stable prefix: ${serialized}`,
      ).toBe(true);
    }
  });

  it("authors failure reasons on write and trusts stored values on read", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: JOB_ID,
        action: "finished",
        status: "error",
        error: "upstream unavailable: 503 overloaded",
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

  it("preserves every canonical failover reason in stored run history", () => {
    for (const errorReason of FAILOVER_REASONS) {
      const entry = {
        ts: 100,
        jobId: JOB_ID,
        action: "finished",
        status: "error",
        errorReason,
      } as const;

      expect(parseCronRunLogEntryObject(entry)?.errorReason).toBe(errorReason);
    }
  });
});

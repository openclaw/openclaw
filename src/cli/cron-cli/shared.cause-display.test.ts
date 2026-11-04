import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../../logging/timestamps.js";
import { defaultRuntime } from "../../runtime.js";
import { printCronJson } from "./shared.js";

function captureCronJson(value: unknown): unknown {
  let written: unknown;
  const original = defaultRuntime.writeJson;
  defaultRuntime.writeJson = (entry: unknown) => {
    written = entry;
  };
  try {
    printCronJson(value);
  } finally {
    defaultRuntime.writeJson = original;
  }
  return written;
}

describe("printCronJson run display", () => {
  it("adds cause and readable timestamps without changing raw run fields", () => {
    const raw = {
      ts: 1_733_551_200_123,
      jobId: "job-1",
      action: "finished",
      status: "error",
      errorReason: "timeout",
      error: "cron: job execution timed out",
      runAtMs: 1_733_551_200_000,
      nextRunAtMs: 1_733_554_800_000,
    };
    const expected = {
      ...raw,
      cause: "timeout",
      tsIso: formatTimestamp(new Date(raw.ts), { style: "long" }),
      runAtIso: formatTimestamp(new Date(raw.runAtMs), { style: "long" }),
      nextRunAtIso: formatTimestamp(new Date(raw.nextRunAtMs), { style: "long" }),
    };
    const written = captureCronJson({ entries: [raw] });
    const entry = (written as { entries: Array<Record<string, unknown>> }).entries[0];
    expect(entry).toEqual(expected);
    expect(entry?.tsIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("omits ISO mirrors when numeric timestamps are absent", () => {
    const written = captureCronJson({
      entries: [{ ts: 1_733_551_200_123, jobId: "job-1", action: "finished", status: "ok" }],
    });
    const entry = (written as { entries: Array<Record<string, unknown>> }).entries[0];
    expect(entry?.tsIso).toBeDefined();
    expect(entry?.runAtIso).toBeUndefined();
    expect(entry?.nextRunAtIso).toBeUndefined();
  });

  it("leaves non-run-log entries untouched", () => {
    const entry = { errorReason: "timeout", status: "error" };
    expect(captureCronJson({ entries: [entry] })).toEqual({
      entries: [{ errorReason: "timeout", status: "error" }],
    });
  });
});

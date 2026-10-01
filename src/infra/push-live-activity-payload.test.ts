import { describe, expect, it } from "vitest";
import { createApnsLiveActivityPayload } from "./push-live-activity-payload.js";
import type { LiveActivitySnapshot } from "./push-live-activity-store.js";

function createInput(status: LiveActivitySnapshot["status"] = "running") {
  return {
    timestamp: 978_307_210,
    snapshot: {
      sourceIncarnation: "source-owner",
      sequence: 1,
      status,
      observedAtMs: 978_307_201_250,
    },
  };
}

describe("Live Activity payload", () => {
  it.each([
    ["running", "running", "update", "5"],
    ["toolRunning", "toolRunning", "update", "5"],
    ["approvalNeeded", "approvalNeeded", "update", "5"],
    ["done", "completed", "end", "10"],
    ["failed", "failed", "end", "10"],
    ["killed", "cancelled", "end", "10"],
    ["timeout", "timedOut", "end", "10"],
  ] as const)("encodes %s as a complete %s state", (status, wireStatus, event, priority) => {
    const payload = createApnsLiveActivityPayload(createInput(status));
    expect(payload.json).toBe(
      JSON.stringify({
        aps: {
          timestamp: 978_307_210,
          event,
          "content-state": { status: wireStatus, observedAt: 1.25 },
          "stale-date": 978_307_441,
          "relevance-score": 10,
        },
      }),
    );
    expect(payload.priority).toBe(priority);
    expect(payload.json).not.toContain("null");
  });

  it("preserves fractional milliseconds in Swift dates and integer APNs envelope seconds", () => {
    const input = createInput("done");
    const payload = createApnsLiveActivityPayload({
      ...input,
      snapshot: {
        ...input.snapshot,
        status: "done",
        observedAtMs: 978_307_200_062.5,
        startedAtMs: 978_307_199_968.75,
        endedAtMs: 978_307_200_031.25,
      },
    });
    expect(payload.value.aps).toEqual({
      timestamp: 978_307_210,
      event: "end",
      "content-state": {
        status: "completed",
        observedAt: 0.0625,
        startedAt: -0.03125,
        endedAt: 0.03125,
      },
      "stale-date": 978_307_440,
      "relevance-score": 10,
    });
  });

  it("keeps retry bytes immutable and excludes source metadata and unapproved fields", () => {
    const input = createInput();
    Object.assign(input.snapshot, {
      sourceIncarnation: "private-source-owner",
      prompt: "private-prompt",
      toolName: "private-tool",
      error: "private-error",
      badge: "private-badge",
    });
    const payload = createApnsLiveActivityPayload(input);
    const bytes = payload.json;
    input.snapshot.status = "failed";
    input.snapshot.observedAtMs += 100_000;
    input.timestamp += 100;
    expect(Reflect.set(payload.value.aps["content-state"], "status", "failed")).toBe(false);
    expect(Reflect.set(payload.value.aps, "timestamp", input.timestamp)).toBe(false);
    expect(Reflect.set(payload, "json", "{}")).toBe(false);
    expect(JSON.stringify(payload.value)).toBe(bytes);
    expect(payload.json).toBe(bytes);
    expect(bytes).not.toContain("private-");
  });

  it("does not refresh stale-date when a later real delivery timestamp is reserved", () => {
    const input = createInput();
    const initial = createApnsLiveActivityPayload(input);
    const later = createApnsLiveActivityPayload({ ...input, timestamp: input.timestamp + 600 });
    expect(later.value.aps["stale-date"]).toBe(initial.value.aps["stale-date"]);
    expect(later.value.aps.timestamp).toBe(input.timestamp + 600);
  });

  it.each(["observedAtMs", "startedAtMs", "endedAtMs"] as const)(
    "rejects malformed %s before constructing sendable bytes",
    (field) => {
      for (const value of [
        Number.NaN,
        Infinity,
        -Infinity,
        -1,
        Number.MAX_SAFE_INTEGER + 1,
        null,
      ]) {
        const input = createInput("done");
        Object.assign(input.snapshot, { [field]: value });
        expect(() => createApnsLiveActivityPayload(input)).toThrow(
          "Invalid Live Activity fact date",
        );
      }
    },
  );

  it.each([Number.NaN, Infinity, -1, 978_307_210.5, 978_307_200, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid reserved timestamp %s",
    (timestamp) => {
      expect(() => createApnsLiveActivityPayload({ ...createInput(), timestamp })).toThrow(
        "Invalid Live Activity date ordering",
      );
    },
  );

  it.each([
    { startedAtMs: 978_307_202_000 },
    { endedAtMs: 978_307_202_000 },
    { startedAtMs: 978_307_201_000, endedAtMs: 978_307_200_000 },
  ])("rejects inconsistent fact dates: %j", (dates) => {
    const input = createInput("done");
    Object.assign(input.snapshot, dates);
    expect(() => createApnsLiveActivityPayload(input)).toThrow(
      "Invalid Live Activity date ordering",
    );
  });

  it("rejects an end date on progress and statuses outside the closed DTO", () => {
    const input = createInput();
    Object.assign(input.snapshot, { endedAtMs: input.snapshot.observedAtMs });
    expect(() => createApnsLiveActivityPayload(input)).toThrow(
      "An active Live Activity cannot have an end date",
    );
    for (const status of ["unknown", "__proto__", "completed", null]) {
      Object.assign(input.snapshot, { status });
      expect(() => createApnsLiveActivityPayload(input)).toThrow("Invalid Live Activity status");
    }
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("bounds bytes at the supported date extreme %s", (date) => {
    const input = createInput("done");
    const payload = createApnsLiveActivityPayload({
      timestamp: Math.floor(date / 1_000),
      snapshot: {
        ...input.snapshot,
        status: "done",
        observedAtMs: date,
        startedAtMs: date,
        endedAtMs: date,
      },
    });
    expect(Buffer.byteLength(payload.json, "utf8")).toBeLessThanOrEqual(2_048);
    expect(payload.value.aps["content-state"].observedAt).toBe(date / 1_000 - 978_307_200);
  });
});

import { describe, it, expect } from "vitest";
import {
  hasActiveToolExecution,
  resolveActiveToolRunId,
  type ActivityEntry,
} from "./tool-activity.ts";

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "run1:tc1",
    toolCallId: "tc1",
    runId: "run1",
    toolName: "exec",
    status: "done",
    startedAt: 1000,
    updatedAt: 2000,
    durationMs: 1000,
    outputTruncated: false,
    summary: "exec completed; 0 arguments hidden",
    hiddenArgumentCount: 0,
    ...overrides,
  };
}

describe("hasActiveToolExecution", () => {
  it("returns false when entries is undefined", () => {
    expect(hasActiveToolExecution(undefined)).toBe(false);
  });

  it("returns false when entries is empty", () => {
    expect(hasActiveToolExecution([])).toBe(false);
  });

  it("returns false when all entries are done", () => {
    expect(hasActiveToolExecution([makeEntry({ status: "done" })])).toBe(false);
  });

  it("returns true when at least one entry is running", () => {
    expect(hasActiveToolExecution([makeEntry({ status: "running" })])).toBe(true);
  });

  it("returns false when all entries are error", () => {
    expect(hasActiveToolExecution([makeEntry({ status: "error" })])).toBe(false);
  });
});

describe("resolveActiveToolRunId", () => {
  it("returns null when entries is undefined", () => {
    expect(resolveActiveToolRunId(undefined)).toBeNull();
  });

  it("returns null when no running entries", () => {
    expect(resolveActiveToolRunId([makeEntry({ status: "done" })])).toBeNull();
  });

  it("returns the runId of the running entry", () => {
    expect(resolveActiveToolRunId([makeEntry({ status: "running", runId: "run-abc" })])).toBe(
      "run-abc",
    );
  });

  it("returns the most recently updated running entry's runId", () => {
    const entries = [
      makeEntry({ id: "r1:tc1", status: "running", runId: "run-old", updatedAt: 1000 }),
      makeEntry({ id: "r2:tc2", status: "running", runId: "run-new", updatedAt: 2000 }),
    ];
    expect(resolveActiveToolRunId(entries)).toBe("run-new");
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  hasActiveToolExecution,
  resolveActiveToolRunId,
  type ActivityEntry,
} from "./activity-model.ts";

function makeEntry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: "run1:tc1",
    toolCallId: "tc1",
    runId: "run1",
    toolName: "exec",
    status: "running",
    startedAt: 1000,
    updatedAt: 2000,
    durationMs: 1000,
    outputTruncated: false,
    summary: "exec running; 1 argument hidden",
    hiddenArgumentCount: 1,
    ...overrides,
  };
}

describe("hasActiveToolExecution", () => {
  it("returns false when activityEntries is undefined", () => {
    expect(hasActiveToolExecution({})).toBe(false);
  });

  it("returns false when activityEntries is empty", () => {
    expect(hasActiveToolExecution({ activityEntries: [] })).toBe(false);
  });

  it("returns false when all entries are done", () => {
    const host = {
      activityEntries: [
        makeEntry({ status: "done" }),
        makeEntry({ id: "run1:tc2", toolCallId: "tc2", status: "done" }),
      ],
    };
    expect(hasActiveToolExecution(host)).toBe(false);
  });

  it("returns true when at least one entry is running", () => {
    const host = {
      activityEntries: [
        makeEntry({ status: "done" }),
        makeEntry({ id: "run1:tc2", toolCallId: "tc2", status: "running" }),
      ],
    };
    expect(hasActiveToolExecution(host)).toBe(true);
  });

  it("returns false when all entries are error", () => {
    const host = {
      activityEntries: [makeEntry({ status: "error" })],
    };
    expect(hasActiveToolExecution(host)).toBe(false);
  });
});

describe("resolveActiveToolRunId", () => {
  it("returns null when activityEntries is undefined", () => {
    expect(resolveActiveToolRunId({})).toBeNull();
  });

  it("returns null when no running entries", () => {
    const host = {
      activityEntries: [makeEntry({ status: "done" })],
    };
    expect(resolveActiveToolRunId(host)).toBeNull();
  });

  it("returns the runId of the running entry", () => {
    const host = {
      activityEntries: [makeEntry({ runId: "run-abc", status: "running" })],
    };
    expect(resolveActiveToolRunId(host)).toBe("run-abc");
  });

  it("returns the most recently updated running entry's runId", () => {
    const host = {
      activityEntries: [
        makeEntry({ id: "r1:tc1", runId: "run-old", status: "running", updatedAt: 1000 }),
        makeEntry({ id: "r2:tc1", runId: "run-new", status: "running", updatedAt: 2000 }),
        makeEntry({ id: "r3:tc1", runId: "run-done", status: "done", updatedAt: 3000 }),
      ],
    };
    expect(resolveActiveToolRunId(host)).toBe("run-new");
  });
});

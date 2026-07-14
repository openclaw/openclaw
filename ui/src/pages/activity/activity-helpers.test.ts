import { describe, expect, it } from "vitest";
import {
  hasActiveToolExecution,
  resolveActiveToolRunId,
  type ActivityEntry,
} from "./tool-activity.ts";

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "run1:call1",
    toolCallId: "call1",
    runId: "run1",
    sessionKey: "session1",
    toolName: "shell",
    status: "done",
    startedAt: 1000,
    updatedAt: 2000,
    durationMs: 1000,
    outputTruncated: false,
    summary: "shell completed; 0 arguments hidden",
    hiddenArgumentCount: 0,
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

  it("returns false when all entries are done or error", () => {
    expect(
      hasActiveToolExecution({
        activityEntries: [
          makeEntry({ status: "done" }),
          makeEntry({ id: "run1:call2", toolCallId: "call2", status: "error" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when at least one entry is running", () => {
    expect(
      hasActiveToolExecution({
        activityEntries: [
          makeEntry({ status: "done" }),
          makeEntry({ id: "run1:call2", toolCallId: "call2", status: "running" }),
        ],
      }),
    ).toBe(true);
  });

  it("returns true when all entries are running", () => {
    expect(
      hasActiveToolExecution({
        activityEntries: [
          makeEntry({ status: "running" }),
          makeEntry({ id: "run1:call2", toolCallId: "call2", status: "running" }),
        ],
      }),
    ).toBe(true);
  });
});

describe("resolveActiveToolRunId", () => {
  it("returns null when activityEntries is undefined", () => {
    expect(resolveActiveToolRunId({})).toBeNull();
  });

  it("returns null when activityEntries is empty", () => {
    expect(resolveActiveToolRunId({ activityEntries: [] })).toBeNull();
  });

  it("returns null when no entries are running", () => {
    expect(
      resolveActiveToolRunId({
        activityEntries: [
          makeEntry({ status: "done" }),
          makeEntry({ id: "run1:call2", toolCallId: "call2", status: "error" }),
        ],
      }),
    ).toBeNull();
  });

  it("returns the runId of the first running entry", () => {
    expect(
      resolveActiveToolRunId({
        activityEntries: [
          makeEntry({ status: "done", runId: "run-old" }),
          makeEntry({
            id: "run2:call3",
            toolCallId: "call3",
            runId: "run2",
            status: "running",
          }),
          makeEntry({
            id: "run3:call4",
            toolCallId: "call4",
            runId: "run3",
            status: "running",
          }),
        ],
      }),
    ).toBe("run2");
  });

  it("returns correct runId for a single running entry", () => {
    expect(
      resolveActiveToolRunId({
        activityEntries: [makeEntry({ status: "running", runId: "active-run-123" })],
      }),
    ).toBe("active-run-123");
  });
});

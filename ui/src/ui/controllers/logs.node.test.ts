// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { loadLogs, type LogsState } from "./logs.ts";

function createLogsState(payload: unknown, entries: LogsState["logsEntries"] = []): LogsState {
  return {
    client: { request: vi.fn(async () => payload) } as unknown as LogsState["client"],
    connected: true,
    logsLoading: false,
    logsError: null,
    logsCursor: entries.length > 0 ? 10 : null,
    logsFile: null,
    logsEntries: entries,
    logsTruncated: false,
    logsLastFetchAt: null,
    logsLimit: 500,
    logsMaxBytes: 250_000,
  };
}

describe("loadLogs", () => {
  it("re-anchors instead of appending when the tail payload skipped bytes", async () => {
    const state = createLogsState(
      {
        file: "/tmp/openclaw.log",
        cursor: 100,
        lines: ["fresh after skipped window"],
        truncated: true,
        reset: false,
        skippedBytes: 42,
      },
      [{ raw: "older entry", message: "older entry" }],
    );

    await loadLogs(state, { quiet: true });

    expect(state.logsEntries.map((entry) => entry.message)).toEqual(["fresh after skipped window"]);
    expect(state.logsTruncated).toBe(true);
    expect(state.logsCursor).toBe(100);
  });
});

import { describe, expect, it } from "vitest";
import { parseLogLine, type ParsedLogLine } from "./parse-log-line.js";

function expectParsed(record: Record<string, unknown>, expected: Partial<ParsedLogLine>) {
  const raw = JSON.stringify(record);
  expect(parseLogLine(raw)).toMatchObject({ ...expected, raw });
}
const context = (subsystem: string) => JSON.stringify({ subsystem });

describe("parseLogLine", () => {
  it("parses structured JSON log lines", () => {
    const subsystem = "gateway/channels/demo-channel";
    const time = "2026-01-09T01:38:41.523Z";
    expectParsed(
      {
        time,
        0: context(subsystem),
        1: "connected",
        _meta: { name: context(subsystem), logLevelName: "INFO" },
      },
      { time, level: "info", subsystem, message: `${context(subsystem)} connected` },
    );
  });
  it("prefers the complete persisted message while preserving numeric joining as fallback", () => {
    expectParsed(
      {
        0: context("gateway"),
        1: "request failed",
        2: "retry later",
        message: "request failed retry later",
      },
      { message: "request failed retry later" },
    );
    expectParsed(
      { 0: "worker", 1: "request failed", 2: { retry: true } },
      { message: 'worker request failed {"retry":true}' },
    );
  });
  it("uses structured metadata context before a structured positional fallback", () => {
    expectParsed(
      { 0: context("legacy"), 1: "ready", _meta: { name: '{"module":"queue"}' } },
      { module: "queue" },
    );
    expectParsed({ 0: context("legacy"), 1: "ready" }, { subsystem: "legacy" });
    expectParsed({ 0: "worker", 1: "ready" }, { subsystem: undefined });
  });
  it("retains the exact plugin identity from logger binding metadata", () => {
    expectParsed(
      {
        0: context("gateway/channels/external-chat"),
        1: "sent",
        _meta: { name: '{"plugin":"vendor-external-chat","feature":"delivery"}' },
      },
      { plugin: "vendor-external-chat", subsystem: "gateway/channels/external-chat" },
    );
  });
  it("falls back to meta timestamp when top-level time is missing", () => {
    const time = "2026-01-09T02:10:00.000Z";
    expectParsed(
      { 0: "hello", _meta: { name: context("gateway"), logLevelName: "WARN", date: time } },
      { time, level: "warn" },
    );
  });
  it("preserves JSON console fields without overriding tslog metadata", () => {
    const record = { level: "warn", subsystem: "gateway", message: "console warning" };
    expectParsed(record, record);
    expectParsed(
      { ...record, _meta: { logLevelName: "ERROR", name: context("worker") } },
      { level: "error", subsystem: "worker" },
    );
    expectParsed(
      { level: 4, subsystem: false, message: "control" },
      { level: undefined, subsystem: undefined, message: "control" },
    );
  });
  it("returns null for invalid JSON", () => {
    expect(parseLogLine("not-json")).toBeNull();
    expect(parseLogLine("null")).toBeNull();
  });
});

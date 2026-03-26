import { describe, expect, it } from "vitest";
import {
  detectTranscriptTailSignals,
  type TranscriptTailEntry,
} from "./transcript-tail-detector.js";

describe("detectTranscriptTailSignals", () => {
  it("groups repeated tool failures with the same normalized signature", () => {
    const entries: TranscriptTailEntry[] = [
      toolFailure("t1", "searchWeb", "Request 123 timed out after 45 seconds"),
      toolFailure("t2", "searchWeb", "request 987 timed out after 31 seconds"),
    ];

    expect(detectTranscriptTailSignals(entries).repeatedToolFailures).toEqual([
      {
        signature: "searchweb: request <num> timed out after <num> seconds",
        count: 2,
        lastSeenEntryId: "t2",
      },
    ]);
  });

  it("separates different tool failures into distinct groups", () => {
    const entries: TranscriptTailEntry[] = [
      toolFailure("a1", "searchWeb", "Request 123 timed out after 45 seconds"),
      toolFailure("a2", "searchWeb", "Permission denied for workspace alpha"),
      toolFailure("a3", "fetchFile", "Request 999 timed out after 45 seconds"),
    ];

    expect(detectTranscriptTailSignals(entries).repeatedToolFailures).toEqual([]);
  });

  it("detects duplicate assistant clusters from repeated normalized text", () => {
    const entries: TranscriptTailEntry[] = [
      { role: "assistant", text: "Working on it now." },
      { role: "assistant", text: "  working   on it now.  " },
      { role: "assistant", text: "Different reply" },
    ];

    expect(detectTranscriptTailSignals(entries).duplicateAssistantClusters).toBe(1);
  });

  it("detects stale directive-like system recurrences", () => {
    const entries: TranscriptTailEntry[] = [
      {
        role: "system",
        kind: "reminder",
        text: "Reminder: do not retry the same failed tool call.",
      },
      { role: "assistant", text: "I will avoid that." },
      {
        role: "system",
        kind: "reminder",
        text: " reminder:   do not retry the same failed tool call. ",
      },
    ];

    expect(detectTranscriptTailSignals(entries).staleSystemRecurrences).toBe(1);
  });

  it("does not flag legitimate post-compaction reinjection prefixes as stale", () => {
    const entries: TranscriptTailEntry[] = [
      {
        role: "system",
        text: "[Post-compaction context refresh]\nKeep going.",
      },
      {
        role: "system",
        text: "Session was just compacted.\nPlease continue.",
      },
      {
        role: "system",
        text: "Injected sections from AGENTS.md\n- rule one",
      },
      {
        role: "system",
        text: "Current time: 2026-03-16T12:34:56Z\nTimezone: UTC",
      },
      {
        role: "system",
        text: "Critical rules from AGENTS.md:\n- do not reset",
      },
      {
        role: "system",
        text: "  Current time: 2026-03-16T12:35:56Z\nTimezone: UTC",
      },
    ];

    expect(detectTranscriptTailSignals(entries).staleSystemRecurrences).toBe(0);
  });

  it("counts trailing user turns without a non-empty assistant reply", () => {
    const entries: TranscriptTailEntry[] = [
      { role: "assistant", text: "Earlier grounded answer." },
      { role: "user", text: "Can you keep going?" },
      { role: "toolResult", toolName: "searchWeb", toolStatus: "error", errorText: "timeout" },
      { role: "assistant", text: "   " },
      { role: "user", text: "Still waiting." },
    ];

    expect(detectTranscriptTailSignals(entries).noGroundedReplyTurns).toBe(2);
  });

  it("reports multiple signal types together in a mixed tail", () => {
    const entries: TranscriptTailEntry[] = [
      {
        role: "system",
        text: "[Post-compaction context refresh]\nContext restored.",
      },
      {
        id: "tool-1",
        role: "toolResult",
        toolName: "searchWeb",
        toolStatus: "error",
        errorText: "HTTP 500 for request 12345",
      },
      { role: "assistant", text: "I will check that now." },
      {
        role: "system",
        kind: "reminder",
        text: "Reminder: always acknowledge repeated tool failures before retrying.",
      },
      {
        id: "tool-2",
        role: "toolResult",
        toolName: "searchWeb",
        isError: true,
        errorText: "http 500 for request 99999",
      },
      { role: "assistant", text: "  i will check that now. " },
      {
        role: "system",
        kind: "reminder",
        text: " reminder: always acknowledge repeated tool failures before retrying. ",
      },
      { role: "user", text: "Any update?" },
      { role: "user", text: "Please answer directly." },
    ];

    expect(detectTranscriptTailSignals(entries)).toEqual({
      repeatedToolFailures: [
        {
          signature: "searchweb: http <num> for request <num>",
          count: 2,
          lastSeenEntryId: "tool-2",
        },
      ],
      duplicateAssistantClusters: 1,
      staleSystemRecurrences: 1,
      noGroundedReplyTurns: 2,
    });
  });
});

function toolFailure(id: string, toolName: string, errorText: string): TranscriptTailEntry {
  return {
    id,
    role: "toolResult",
    toolName,
    toolStatus: "error",
    errorText,
  };
}

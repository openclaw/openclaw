import { describe, expect, it } from "vitest";
import { buildRecordedToolLookup, resolveRecordedToolResult } from "./recorded-tools.js";

describe("recorded tools", () => {
  it("resolves recorded result by toolCallId and toolName", () => {
    const lookup = buildRecordedToolLookup({
      v: 1,
      session: { agentId: "a", sessionId: "s" },
      messages: [],
      events: [],
      toolCalls: [
        {
          stepIdx: 0,
          toolCallId: "call-1",
          toolName: "exec",
          startTs: 1,
          endTs: 2,
          ok: true,
          resultSummary: "ok",
        },
      ],
      summary: { messageCount: 0, eventCount: 0, toolCallCount: 1 },
    });
    const out = resolveRecordedToolResult({
      lookup,
      toolCallId: "call-1",
      toolName: "exec",
    });
    expect(out.resultSummary).toBe("ok");
  });
});

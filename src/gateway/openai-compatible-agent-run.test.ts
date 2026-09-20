import { describe, expect, it } from "vitest";
import { readOpenAiHttpRunTerminal } from "./openai-compatible-agent-run.js";

describe("OpenAI-compatible agent run terminal metadata", () => {
  it.each([undefined, null, "invalid", [], { pendingToolCalls: "invalid" }])(
    "treats malformed metadata as having no pending calls: %j",
    (meta) => {
      expect(readOpenAiHttpRunTerminal({ meta })).toMatchObject({
        runFailed: false,
        pendingToolCalls: undefined,
      });
    },
  );

  it("filters malformed calls and normalizes the valid calls for both HTTP protocols", () => {
    expect(
      readOpenAiHttpRunTerminal({
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [
            null,
            { id: 7, name: "ignored", arguments: "{}" },
            { id: " call_1 ", name: " get_weather ", arguments: { city: "Taipei" } },
          ],
        },
      }),
    ).toEqual({
      runFailed: false,
      stopReason: "tool_calls",
      pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' }],
    });
  });

  it("ignores a malformed stop reason without discarding valid calls", () => {
    expect(
      readOpenAiHttpRunTerminal({
        meta: {
          stopReason: 42,
          pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
        },
      }),
    ).toMatchObject({
      stopReason: undefined,
      pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    });
  });
});

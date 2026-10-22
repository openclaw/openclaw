import type { AgentMessage } from "@openclaw/agent-core";
import { describe, expect, it } from "vitest";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createModelContextPairing, PREFIX_TOOL_OWNER } from "./session-model-context-pairing.js";

function call(id: string) {
  return makeAgentAssistantMessage({
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
}

function result(id: string, synthetic = false): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: synthetic ? "missing" : "output" }],
    isError: synthetic,
    ...(synthetic ? { details: { openclawSyntheticMissingToolResult: true } } : {}),
    timestamp: 0,
  };
}

describe("bounded model-context pairing", () => {
  it("keeps discarded owners distinct from suffix owners and orders their cut spans", () => {
    const older = call("older");
    const olderResult = result("older");
    const recent = call("recent");
    const recentResult = result("recent");
    const retained = [olderResult, recent, recentResult];
    const pairing = createModelContextPairing([older, ...retained], retained);

    expect([...pairing.read()]).toEqual([
      [olderResult, PREFIX_TOOL_OWNER],
      [recentResult, recent],
    ]);
    pairing.retain([recentResult]);
    expect([...pairing.read()]).toEqual([[recentResult, PREFIX_TOOL_OWNER]]);
  });

  it("accepts local results after unresolved-prefix overflow, including reused IDs", () => {
    const older = call("X");
    const unrelated = call("Z");
    const recent = call("Y");
    const pairing = createModelContextPairing([older, unrelated, recent], [recent], {
      maxOccurrences: 1,
    });
    const recentResult = result("Y");
    expect(pairing.append([recentResult])).toBe(true);
    const next = call("X");
    const nextResult = result("X");
    expect(pairing.append([next, nextResult])).toBe(true);
    pairing.retain([next, nextResult]);
    expect([...pairing.read()]).toEqual([[nextResult, next]]);
  });

  it("requires recovery when a new displaced result could become falsely unambiguous", () => {
    const older = call("X");
    const recent = call("X");
    const other = call("Y");
    const pairing = createModelContextPairing([older, recent, other], [recent, other], {
      maxOccurrences: 0,
    });

    expect(pairing.append([result("X")])).toBe(false);
  });

  it("preserves ambiguous ownership when both unresolved occurrences fit", () => {
    const older = call("X");
    const recent = call("X");
    const other = call("Y");
    const pairing = createModelContextPairing([older, recent, other], [recent, other]);
    const displaced = result("X");

    expect(pairing.append([displaced])).toBe(true);
    expect(pairing.read().has(displaced)).toBe(false);
  });

  it("replaces a retained synthetic result owned by a discarded frame", () => {
    const older = call("X");
    const missing = result("X", true);
    const recent = call("Y");
    const pairing = createModelContextPairing([older, missing, recent], [missing, recent]);
    const replacement = result("X");

    expect(pairing.append([replacement])).toBe(true);
    expect(pairing.read().has(missing)).toBe(false);
    expect(pairing.read().get(replacement)).toBe(PREFIX_TOOL_OWNER);
  });

  it("keeps the last tool frame through user and plain assistant messages", () => {
    const assistant = call("X");
    const completed = result("X");
    const plain: AgentMessage[] = [
      { role: "user", content: "continue", timestamp: 0 },
      makeAgentAssistantMessage({ content: [{ type: "text", text: "continuing" }] }),
    ];
    const pairing = createModelContextPairing([assistant, completed, ...plain], plain);
    const duplicate = result("X");

    expect(pairing.append([duplicate])).toBe(true);
    expect(pairing.read().has(duplicate)).toBe(false);
  });

  it("recovers an oversized frame but resumes local pairing at the next frame", () => {
    const oversized = call("X".repeat(4096));
    const pairing = createModelContextPairing([oversized], [], { maxBytes: 1024 });

    expect(pairing.append([result("X".repeat(4096))])).toBe(false);
    const next = call("next");
    const nextResult = result("next");
    expect(pairing.append([next, nextResult])).toBe(true);
    expect(pairing.read().get(nextResult)).toBe(next);
  });

  it("keeps retained live-frame results canonical across appends beyond the prefix cap", () => {
    const results = Array.from({ length: 300 }, (_, index) => result(`call-${index}`));
    const assistant = makeAgentAssistantMessage({
      content: results.map(({ toolCallId }) => ({
        type: "toolCall",
        id: toolCallId,
        name: "read",
        arguments: {},
      })),
      stopReason: "toolUse",
    });
    const retained: AgentMessage[] = [assistant];
    const pairing = createModelContextPairing(retained, retained);

    for (let start = 0; start < results.length; start += 100) {
      const appended = results.slice(start, start + 100);
      expect(pairing.append(appended)).toBe(true);
      retained.push(...appended);
      pairing.retain(retained);
      const actual = pairing.read();
      expect(actual.size).toBe(retained.length - 1);
      for (const frame of classifyToolUseResultPairing(retained)) {
        for (const occurrence of frame.occurrences) {
          if (occurrence.sourceResult) {
            expect(actual.get(occurrence.sourceResult)).toBe(frame.assistant);
          }
        }
      }
    }
  });

  it("bounds a formerly retained live frame when its assistant leaves the window", () => {
    const assistant = makeAgentAssistantMessage({
      content: Array.from({ length: 300 }, (_, index) => ({
        type: "toolCall",
        id: `call-${index}`,
        name: "read",
        arguments: {},
      })),
      stopReason: "toolUse",
    });
    const completed = result("call-0");
    const pairing = createModelContextPairing([assistant], [assistant]);
    expect(pairing.append([completed])).toBe(true);

    pairing.retain([completed]);
    pairing.retain([completed]);
    expect(pairing.read().get(completed)).toBe(PREFIX_TOOL_OWNER);
    expect(pairing.append([result("call-1")])).toBe(false);
  });

  it("forgets fulfilled overflow when the next tool frame starts", () => {
    const id = "X".repeat(4096);
    const next = call("next");
    const pairing = createModelContextPairing([call(id), result(id)], [], { maxBytes: 1024 });
    const orphan = result("unrelated");

    expect(pairing.append([next, orphan])).toBe(true);
    expect(pairing.read().has(orphan)).toBe(false);
  });

  it("does not recover unknown prefix ownership for a result without an ID", () => {
    const next = call("next");
    const pairing = createModelContextPairing([call("older"), next], [next], {
      maxOccurrences: 0,
    });
    const orphan = { ...result(""), toolName: "another_tool" };

    expect(pairing.append([orphan])).toBe(true);
    expect(pairing.read().has(orphan)).toBe(false);
  });
});

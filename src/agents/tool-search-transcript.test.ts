import { it, expect } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/session-manager.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";

it.each([undefined, { nested: { values: ["output 🦞\ud800", 7] } }])(
  "reuses sealed nested tool payloads while normalizing the control envelope (%j)",
  async (details) => {
    const target = snapshotToolSearchTargetTranscriptResult({
      content: [{ type: "text", text: "nested result" }],
      details,
    });
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);
    const live = {
      ...makeTextToolResult("call_1", "tool_call", "control result", false, 1),
      content: target.content,
      details: { result: target, missing: undefined, count: Number.NaN },
    };
    const expected = JSON.stringify(live);
    await sm.appendMessageAsync(live);
    const persisted = sm.getEntries().find((entry) => entry.type === "message")?.message;
    expect(JSON.stringify(persisted)).toBe(expected);
    if (persisted?.role !== "toolResult") {
      throw new Error("expected persisted tool result");
    }
    expect(persisted.content).toBe(target.content);
    expect(persisted.details).toMatchObject({
      result: details === undefined ? {} : { details },
      count: null,
    });
    expect(Object.isFrozen(target.content[0])).toBe(true);
    expect(Object.hasOwn(target, "details")).toBe(true);
  },
);

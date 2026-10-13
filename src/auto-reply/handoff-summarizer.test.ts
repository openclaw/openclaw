import { describe, expect, it } from "vitest";
import { buildHierarchyReinforcementMessage } from "./handoff-summarizer.js";

const handoffHeader =
  "[SYSTEM HANDOFF] The previous model is no longer active and a fallback model is now active.";

describe("buildHierarchyReinforcementMessage", () => {
  it("keeps solo recovery context without team instructions", () => {
    const message = buildHierarchyReinforcementMessage({
      summary: "Continue the user's request.",
      activeSubagents: [],
    });
    expect(message).toMatchObject({
      role: "user",
      content: [
        handoffHeader,
        "Review the current state below and continue the conversation from where the previous model left off.",
        "",
        "CURRENT STATE SUMMARY:",
        "Continue the user's request.",
      ].join("\n"),
    });
  });

  it("preserves the complete team handoff when subagents exist", () => {
    const message = buildHierarchyReinforcementMessage({
      summary: "Review the implementation and deployment.",
      activeSubagents: [
        { sessionId: "worker-1", role: "researcher", lastStatus: "complete" },
        { sessionId: "worker-2" },
      ],
    });
    expect(message).toMatchObject({
      role: "user",
      content: [
        handoffHeader,
        "You are the new LEADER (Orchestrator). Do not perform tasks already delegated to subordinates.",
        "",
        "ACTIVE SUBORDINATE UNITS:",
        "- Subagent worker-1 (researcher): complete",
        "- Subagent worker-2 (leaf): running",
        "",
        "CURRENT STATE SUMMARY:",
        "Review the implementation and deployment.",
        "",
        "INSTRUCTIONS:",
        "1. Review the state and subordinate reports.",
        "2. Provide strategic guidance and commands to subordinates.",
        "3. Do not repeat work already performed by subordinates.",
      ].join("\n"),
    });
  });
});

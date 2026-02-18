import { describe, expect, it } from "vitest";
import {
  buildAgentFreezeContext,
  buildTriagePrompt,
  buildUserVerificationText,
  parseTriageResponse,
  type HeldMessage,
} from "./compaction-held-messages.js";

const held = (body: string, senderId?: string): HeldMessage => ({
  body,
  timestamp: 1_000_000,
  senderId,
});

// ────────────────────────────────────────────────────────────────────────────
// buildUserVerificationText
// ────────────────────────────────────────────────────────────────────────────

describe("buildUserVerificationText", () => {
  it("returns fallback when contextData is null and no held messages", () => {
    const text = buildUserVerificationText({ contextData: null, heldMessages: [] });
    expect(text).toContain("⚠️ I was compacting. (No context transfer summary available.)");
    expect(text).toContain("Type 'ok' to resume.");
  });

  it("returns fallback with held messages when contextData is null", () => {
    const text = buildUserVerificationText({
      contextData: null,
      heldMessages: [held("ping"), held("hello")],
    });
    expect(text).toContain("(No context transfer summary available.)");
    expect(text).toContain("[Q1] ping");
    expect(text).toContain("[Q2] hello");
    expect(text).toContain("What should I do? Type 'ok' to resume.");
  });

  it("shows compacting header without tasks when contextData is empty object", () => {
    const text = buildUserVerificationText({ contextData: {}, heldMessages: [] });
    expect(text).toContain("⚠️ I was compacting.");
    expect(text).not.toContain("Here's what I think I was doing:");
  });

  it("shows nextActions from contextData", () => {
    const text = buildUserVerificationText({
      contextData: {
        nextActions: [{ action: "Finish the report", priority: 1 }, { action: "Review PR #42" }],
      },
      heldMessages: [],
    });
    expect(text).toContain("Here's what I think I was doing:");
    expect(text).toContain("1. Finish the report");
    expect(text).toContain("• Review PR #42");
  });

  it("shows nextActions as plain strings", () => {
    const text = buildUserVerificationText({
      contextData: { nextActions: ["deploy to staging", "notify team"] },
      heldMessages: [],
    });
    expect(text).toContain("• deploy to staging");
    expect(text).toContain("• notify team");
  });

  it("shows activeTasks from contextData", () => {
    const text = buildUserVerificationText({
      contextData: {
        activeTasks: [
          { description: "Issue #88 implementation", status: "in-progress" },
          { description: "Write tests" },
        ],
      },
      heldMessages: [],
    });
    expect(text).toContain("• Issue #88 implementation [in-progress]");
    expect(text).toContain("• Write tests");
  });

  it("shows pendingDecisions", () => {
    const text = buildUserVerificationText({
      contextData: { pendingDecisions: ["merge or rebase?", "which model to use?"] },
      heldMessages: [],
    });
    expect(text).toContain("Pending decisions:");
    expect(text).toContain("• merge or rebase?");
    expect(text).toContain("• which model to use?");
  });

  it("does NOT show doNotTouch to the user", () => {
    const text = buildUserVerificationText({
      contextData: { doNotTouch: ["AGENTS.md", "scripts/"] },
      heldMessages: [],
    });
    expect(text).not.toContain("Do not touch");
    expect(text).not.toContain("AGENTS.md");
  });

  it("numbers held messages sequentially", () => {
    const text = buildUserVerificationText({
      contextData: null,
      heldMessages: [held("first"), held("second"), held("third")],
    });
    expect(text).toContain("[Q1] first");
    expect(text).toContain("[Q2] second");
    expect(text).toContain("[Q3] third");
  });

  it("shows held messages with context tasks together", () => {
    const text = buildUserVerificationText({
      contextData: {
        nextActions: [{ action: "write tests" }],
      },
      heldMessages: [held("what's the status?")],
    });
    expect(text).toContain("Here's what I think I was doing:");
    expect(text).toContain("• write tests");
    expect(text).toContain("[Q1] what's the status?");
    expect(text).toContain("What should I do? Type 'ok' to resume.");
  });

  it("shows single held message with 'What should I do?' CTA", () => {
    const text = buildUserVerificationText({
      contextData: {},
      heldMessages: [held("urgent: check the build")],
    });
    expect(text).toContain("[Q1] urgent: check the build");
    expect(text).toContain("What should I do? Type 'ok' to resume.");
    expect(text).not.toContain("Type 'ok' to resume.\n");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildAgentFreezeContext
// ────────────────────────────────────────────────────────────────────────────

describe("buildAgentFreezeContext", () => {
  it("returns empty string when contextData is null and no held messages", () => {
    const result = buildAgentFreezeContext({ contextData: null, heldMessages: [] });
    expect(result).toBe("");
  });

  it("includes freeze protocol header", () => {
    const result = buildAgentFreezeContext({
      contextData: null,
      heldMessages: [held("hello")],
    });
    expect(result).toContain("[POST-COMPACTION FREEZE PROTOCOL]");
    expect(result).toContain("Do not process queued messages without explicit user approval.");
  });

  it("includes nextActions from contextData", () => {
    const result = buildAgentFreezeContext({
      contextData: {
        nextActions: [{ action: "Deploy to prod", priority: 1 }, "check logs"],
      },
      heldMessages: [],
    });
    expect(result).toContain("Next actions:");
    expect(result).toContain("• Deploy to prod");
    expect(result).toContain("• check logs");
  });

  it("includes doNotTouch items", () => {
    const result = buildAgentFreezeContext({
      contextData: { doNotTouch: ["AGENTS.md", "scripts/discord-service.py"] },
      heldMessages: [],
    });
    expect(result).toContain("Do not touch:");
    expect(result).toContain("• AGENTS.md");
    expect(result).toContain("• scripts/discord-service.py");
  });

  it("includes queued messages with Q-labels", () => {
    const result = buildAgentFreezeContext({
      contextData: null,
      heldMessages: [held("deploy now"), held("what about Q2 plans?")],
    });
    expect(result).toContain("Queued messages (approved by user):");
    expect(result).toContain("[Q1] deploy now");
    expect(result).toContain("[Q2] what about Q2 plans?");
  });

  it("includes triage footer when there are held messages", () => {
    const result = buildAgentFreezeContext({
      contextData: null,
      heldMessages: [held("ping")],
    });
    expect(result).toContain(
      "Only act on items the user explicitly approves (e.g. 'do Q1 and Q3, skip Q2')",
    );
    expect(result).toContain("Unaddressed queued items are discarded");
  });

  it("does not include triage footer when no held messages", () => {
    const result = buildAgentFreezeContext({
      contextData: { nextActions: ["do thing"] },
      heldMessages: [],
    });
    expect(result).not.toContain("Unaddressed queued items");
    expect(result).not.toContain("Queued messages");
  });

  it("omits pendingDecisions from agent context (those are user-facing)", () => {
    const result = buildAgentFreezeContext({
      contextData: { pendingDecisions: ["which approach?"] },
      heldMessages: [],
    });
    // pendingDecisions are shown to user, not re-injected into agent context
    expect(result).not.toContain("pendingDecisions");
    expect(result).not.toContain("which approach?");
  });

  it("builds correct full context with all fields", () => {
    const result = buildAgentFreezeContext({
      contextData: {
        nextActions: [{ action: "finish report", priority: 1 }],
        doNotTouch: ["src/core/"],
        pendingDecisions: ["pick a model"],
      },
      heldMessages: [held("status?"), held("ETA?", "user123")],
    });
    expect(result).toContain("[POST-COMPACTION FREEZE PROTOCOL]");
    expect(result).toContain("Next actions:");
    expect(result).toContain("• finish report");
    expect(result).toContain("Do not touch:");
    expect(result).toContain("• src/core/");
    expect(result).toContain("[Q1] status?");
    expect(result).toContain("[Q2] ETA?");
    expect(result).not.toContain("pendingDecisions");
    expect(result).not.toContain("pick a model");
  });

  it("injects only approvedMessages when provided", () => {
    const result = buildAgentFreezeContext({
      contextData: null,
      heldMessages: [held("Q1 body"), held("Q2 body"), held("Q3 body")],
      approvedMessages: [held("Q1 body"), held("Q3 body")],
    });
    expect(result).toContain("[Q1] Q1 body");
    expect(result).toContain("[Q2] Q3 body");
    expect(result).not.toContain("Q2 body");
  });

  it("injects freeform instruction with all messages when trageInstruction provided", () => {
    const result = buildAgentFreezeContext({
      contextData: null,
      heldMessages: [held("ping"), held("status?")],
      trageInstruction: "summarize Q1 and ignore Q2",
    });
    expect(result).toContain("freeform instruction");
    expect(result).toContain("User instruction: summarize Q1 and ignore Q2");
    expect(result).toContain("[Q1] ping");
    expect(result).toContain("[Q2] status?");
  });

  it("returns empty string when approvedMessages is empty and no contextData", () => {
    const result = buildAgentFreezeContext({
      contextData: null,
      heldMessages: [held("ping")],
      approvedMessages: [],
    });
    expect(result).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildTriagePrompt
// ────────────────────────────────────────────────────────────────────────────

describe("buildTriagePrompt", () => {
  it("returns empty string for no held messages", () => {
    expect(buildTriagePrompt([])).toBe("");
  });

  it("lists messages with Q-labels", () => {
    const text = buildTriagePrompt([held("ping"), held("status?")]);
    expect(text).toContain("[Q1] ping");
    expect(text).toContain("[Q2] status?");
  });

  it("includes resuming header and CTA", () => {
    const text = buildTriagePrompt([held("test")]);
    expect(text).toContain("✅ Resuming");
    expect(text).toContain("do all");
    expect(text).toContain("skip all");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseTriageResponse
// ────────────────────────────────────────────────────────────────────────────

describe("parseTriageResponse", () => {
  it("returns all for 'do all'", () => {
    expect(parseTriageResponse("do all", 3)).toEqual({ kind: "all" });
  });

  it("returns all for 'handle all'", () => {
    expect(parseTriageResponse("handle all", 3)).toEqual({ kind: "all" });
  });

  it("returns all for 'yes all'", () => {
    expect(parseTriageResponse("yes all", 3)).toEqual({ kind: "all" });
  });

  it("returns all for 'all'", () => {
    expect(parseTriageResponse("all", 3)).toEqual({ kind: "all" });
  });

  it("returns all for 'everything'", () => {
    expect(parseTriageResponse("everything", 3)).toEqual({ kind: "all" });
  });

  it("returns none for 'skip all'", () => {
    expect(parseTriageResponse("skip all", 3)).toEqual({ kind: "none" });
  });

  it("returns none for 'ignore all'", () => {
    expect(parseTriageResponse("ignore all", 3)).toEqual({ kind: "none" });
  });

  it("returns none for 'none'", () => {
    expect(parseTriageResponse("none", 3)).toEqual({ kind: "none" });
  });

  it("parses 'do Q1' → indices [0]", () => {
    expect(parseTriageResponse("do Q1", 3)).toEqual({ kind: "indices", approved: [0] });
  });

  it("parses 'do Q1, Q3' → indices [0, 2]", () => {
    expect(parseTriageResponse("do Q1, Q3", 3)).toEqual({ kind: "indices", approved: [0, 2] });
  });

  it("parses 'Q1 and Q2' → indices [0, 1]", () => {
    expect(parseTriageResponse("Q1 and Q2", 3)).toEqual({ kind: "indices", approved: [0, 1] });
  });

  it("parses 'skip Q2' → all except Q2 (indices [0, 2])", () => {
    expect(parseTriageResponse("skip Q2", 3)).toEqual({ kind: "indices", approved: [0, 2] });
  });

  it("parses 'skip Q1, Q3' → only Q2 approved (index [1])", () => {
    expect(parseTriageResponse("skip Q1, Q3", 3)).toEqual({ kind: "indices", approved: [1] });
  });

  it("returns none when 'skip' causes all to be skipped", () => {
    expect(parseTriageResponse("skip Q1", 1)).toEqual({ kind: "none" });
  });

  it("ignores out-of-range Q numbers", () => {
    // Q5 doesn't exist in a 3-message list
    expect(parseTriageResponse("do Q1, Q5", 3)).toEqual({ kind: "indices", approved: [0] });
  });

  it("returns freeform for arbitrary instruction", () => {
    const result = parseTriageResponse("summarize Q1 and ignore Q2", 3);
    expect(result).toEqual({ kind: "freeform", instruction: "summarize Q1 and ignore Q2" });
  });

  it("returns freeform for completely unrecognized text", () => {
    const result = parseTriageResponse("what was I doing?", 3);
    expect(result.kind).toBe("freeform");
  });
});

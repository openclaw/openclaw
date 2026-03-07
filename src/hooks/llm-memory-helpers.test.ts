import { describe, expect, it } from "vitest";
import { evaluateSessionImportance } from "./llm-memory-helpers.js";
import type { ParsedMessage } from "./transcript-reader.js";

function msgs(...pairs: Array<[role: "user" | "assistant", text: string]>): ParsedMessage[] {
  return pairs.map(([role, text]) => ({ role, text }));
}

describe("evaluateSessionImportance", () => {
  // -- Explicit intent probes -----------------------------------------------

  it("should instantly pass on 'remember' keyword", () => {
    const result = evaluateSessionImportance(
      msgs(["user", "Please remember this: my server IP is 10.0.0.1"]),
    );
    expect(result.pass).toBe(true);
    expect(result.hintCategory).toBe("reference");
    expect(result.matchedKeywords).toContain("remember");
  });

  it("should instantly pass on Chinese explicit intent '记住'", () => {
    const result = evaluateSessionImportance(msgs(["user", "记住这个密码"]));
    expect(result.pass).toBe(true);
    expect(result.hintCategory).toBe("reference");
  });

  it("should instantly pass on '别忘了'", () => {
    const result = evaluateSessionImportance(msgs(["user", "别忘了明天开会"]));
    expect(result.pass).toBe(true);
    expect(result.hintCategory).toBe("reference");
  });

  // -- Trivial conversations should not pass --------------------------------

  it("should reject trivial chit-chat", () => {
    const result = evaluateSessionImportance(
      msgs(
        ["user", "Hi"],
        ["assistant", "Hello!"],
        ["user", "How are you?"],
        ["assistant", "Great, thanks!"],
      ),
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(4);
  });

  // -- Code block density ---------------------------------------------------

  it("should pass on high code block density (>= 3 blocks)", () => {
    const code = "```ts\nconsole.log('hello');\n```";
    const result = evaluateSessionImportance(
      msgs(
        ["user", `Check this:\n${code}`],
        ["assistant", `Here's a fix:\n${code}\nAnd another:\n${code}`],
        ["user", `What about:\n${code}`],
      ),
    );
    expect(result.pass).toBe(true);
    expect(result.signals.some((s) => s.startsWith("code-blocks:"))).toBe(true);
  });

  it("should give partial score for 1-2 code blocks", () => {
    const code = "```ts\nconst x = 1;\n```";
    const result = evaluateSessionImportance(
      msgs(["user", `Is this right?\n${code}`], ["assistant", "Yes, that looks correct."]),
    );
    // 1 code block = +2, not enough alone to pass threshold of 4
    expect(result.score).toBeGreaterThanOrEqual(2);
    // But without other signals, should not pass
    expect(result.pass).toBe(false);
  });

  // -- User message depth (P75) ---------------------------------------------

  it("should pass when user messages are consistently long", () => {
    const longMsg = "A".repeat(200);
    const result = evaluateSessionImportance(
      msgs(
        ["user", `I have a complex problem: ${longMsg}`],
        ["assistant", "Let me think about that."],
        ["user", `Here's more context: ${longMsg}`],
        ["assistant", "I see, that helps."],
        ["user", `And also consider: ${longMsg}`],
        ["assistant", "Got it."],
      ),
    );
    // P75 user msg length > 150 = +3, plus turns (6) not enough alone,
    // but depth should combine to pass
    expect(result.signals.some((s) => s.startsWith("user-msg-depth:"))).toBe(true);
  });

  // -- Collaboration intensity ----------------------------------------------

  it("should detect structured assistant replies", () => {
    const structuredReply = [
      "## Overview of the System Architecture",
      "",
      "Here are the key considerations for this design decision:",
      "",
      "- First, we need to ensure backward compatibility with the existing API surface",
      "- Second, the new caching layer must handle concurrent invalidation correctly",
      "- Third, we should implement circuit breakers for all external service calls",
      "- Fourth, the database migration must be backward-compatible and reversible",
      "",
      "## Detailed Recommendation",
      "",
      "Based on the analysis above, here is my recommended approach for the rollout.",
    ].join("\n");

    const result = evaluateSessionImportance(
      msgs(
        ["user", "Can you analyze this architecture?"],
        ["assistant", structuredReply],
        ["user", "What about scalability?"],
        ["assistant", structuredReply],
      ),
    );
    expect(result.signals.some((s) => s.startsWith("collab-intensity:"))).toBe(true);
  });

  // -- Domain keywords as score contributors --------------------------------

  it("should score domain keywords additively", () => {
    const result = evaluateSessionImportance(
      msgs(
        ["user", "Let's discuss the architecture decision"],
        ["assistant", "What are the options?"],
      ),
    );
    // "architecture" and "decision" should each add +1
    expect(result.matchedKeywords).toContain("architecture");
    expect(result.matchedKeywords).toContain("decision");
    expect(result.score).toBeGreaterThanOrEqual(2);
  });

  it("should infer hintCategory from highest-scoring domain", () => {
    const result = evaluateSessionImportance(
      msgs(
        ["user", "The experiment findings show our hypothesis was correct"],
        ["assistant", "That's great news for the research."],
      ),
    );
    // "experiment", "findings", "hypothesis" → research category
    expect(result.hintCategory).toBe("research");
  });

  // -- Custom keywords ------------------------------------------------------

  it("should score custom keywords from config", () => {
    const result = evaluateSessionImportance(
      msgs(["user", "The JIRA-1234 ticket needs a hotfix"], ["assistant", "I'll look into it."]),
      ["JIRA", "hotfix"],
    );
    expect(result.matchedKeywords).toContain("hotfix");
    // Custom keyword = +2 each
    expect(result.score).toBeGreaterThanOrEqual(2);
  });

  // -- Combined signals should cross threshold ------------------------------

  it("should pass when multiple moderate signals combine", () => {
    const result = evaluateSessionImportance(
      msgs(
        [
          "user",
          "I need to deploy the release by the milestone deadline. Here's the current status: the sprint is on track but we need to finalize the roadmap. I've prepared a detailed document explaining each phase.",
        ],
        [
          "assistant",
          "## Deployment Plan\n\n- Phase 1: Staging deployment\n- Phase 2: Production rollout\n- Phase 3: Monitoring\n\nLet me review the timeline and provide recommendations for each milestone.",
        ],
        [
          "user",
          "Good analysis. Can you compare option A versus option B for the rollout strategy? What are the trade-off considerations?",
        ],
        [
          "assistant",
          "## Comparison\n\n- Option A: Blue-green deployment\n  - Pro: Zero downtime\n  - Con: Double infrastructure cost\n\n- Option B: Rolling update\n  - Pro: Cost efficient\n  - Con: Partial availability during transition",
        ],
      ),
    );
    // Should accumulate: keywords (deploy, release, milestone, etc.) +
    // collab-intensity (structured replies) + user-msg-depth
    expect(result.pass).toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  // -- URL presence ---------------------------------------------------------

  it("should detect URLs as a weak signal", () => {
    const result = evaluateSessionImportance(
      msgs(
        ["user", "Check this article: https://example.com/long-article-about-system-design"],
        ["assistant", "Interesting read."],
      ),
    );
    expect(result.signals).toContain("has-urls");
    // URL alone = +1, not enough to pass
    expect(result.score).toBeGreaterThanOrEqual(1);
  });
});

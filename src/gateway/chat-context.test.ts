import { describe, expect, it } from "vitest";
import { applyChatHistoryWindow, buildContextBudgetBreakdown } from "./chat-context.js";

function textMessage(role: string, text: string, timestamp = Date.now()) {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  };
}

describe("gateway chat context", () => {
  it("transcript summary line is filtered from tail in summary mode", () => {
    const result = applyChatHistoryWindow({
      agentId: "main",
      sessionKey: "agent:main:chat:test",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "old summary" }],
          timestamp: 1,
          synthetic: true,
          summary: true,
        },
        textMessage("user", "recent request", 2),
        textMessage("assistant", "recent reply", 3),
      ],
      historyMode: "summary",
      tailCount: 10,
    });

    const summaryCount = result.messages.filter(
      (message) => (message as { synthetic?: boolean; summary?: boolean }).synthetic === true,
    ).length;
    expect(summaryCount).toBeLessThanOrEqual(1);
    expect(JSON.stringify(result.messages)).not.toContain("old summary");
  });

  it("builds visible context budget breakdown", () => {
    const budget = buildContextBudgetBreakdown({
      sessionKey: "agent:main:chat:test",
      agentId: "main",
      historyMode: "summary",
      summaryText: "Current status: fix bug",
      recentTailMessages: [textMessage("user", "latest request")],
      memoryText: "OPENAI_API_KEY",
    });

    expect(budget.sessionKey).toBe("agent:main:chat:test");
    expect(budget.agentId).toBe("main");
    expect(budget.historyMode).toBe("summary");
    expect(budget.summaryTokens).toBeGreaterThan(0);
    expect(budget.recentTailTokens).toBeGreaterThan(0);
    expect(budget.memoryTokens).toBeGreaterThan(0);
    expect(budget.finalTotalTokens).toBe(
      budget.summaryTokens + budget.recentTailTokens + budget.memoryTokens,
    );
  });
});

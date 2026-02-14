import { describe, expect, it } from "vitest";
import {
  analyzeChatQuick,
  type ChatMessage,
  type ChatResult,
  formatBriefing,
  generateDirectives,
  type WarroomConfig,
} from "./warroom-briefing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    timestamp: "2026-02-06T10:00:00Z",
    direction: "inbound",
    channel: "telegram",
    chat_id: "-100",
    chat_name: "Test Chat",
    sender_id: "user1",
    sender_name: "Alice",
    content: "hello",
    media_type: "",
    ...overrides,
  };
}

function chatResult(overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    chatId: "-100",
    name: "Test Chat",
    channel: "telegram",
    totalMessages: 20,
    uniqueSenders: 5,
    agentSummaries: [],
    ...overrides,
  };
}

const defaultConfig: WarroomConfig = {
  version: "0.2",
  monitored_chats: [
    {
      id: "-100",
      name: "Test Chat",
      channel: "telegram",
      agents: [{ id: "bot1", name: "Dofu" }],
    },
  ],
  agent_visibility_threshold: 30,
};

// ---------------------------------------------------------------------------
// analyzeChatQuick
// ---------------------------------------------------------------------------

describe("analyzeChatQuick", () => {
  it("returns zeros for empty messages", () => {
    const result = analyzeChatQuick([], [{ id: "bot1", name: "Dofu" }], 30);
    expect(result.totalMessages).toBe(0);
    expect(result.uniqueSenders).toBe(0);
    expect(result.latestTimestamp).toBe("");
    expect(result.agentSummaries[0].count).toBe(0);
    expect(result.agentSummaries[0].pct).toBe(0);
    expect(result.agentSummaries[0].overThreshold).toBe(false);
  });

  it("counts unique senders", () => {
    const messages = [
      msg({ sender_name: "Alice" }),
      msg({ sender_name: "Bob" }),
      msg({ sender_name: "Alice" }),
    ];
    const result = analyzeChatQuick(messages, [], 30);
    expect(result.uniqueSenders).toBe(2);
  });

  it("falls back to sender_id when sender_name is empty", () => {
    const messages = [
      msg({ sender_name: "", sender_id: "uid1" }),
      msg({ sender_name: "", sender_id: "uid2" }),
    ];
    const result = analyzeChatQuick(messages, [], 30);
    expect(result.uniqueSenders).toBe(2);
  });

  it("falls back to ? when both sender_name and sender_id are empty", () => {
    const messages = [msg({ sender_name: "", sender_id: "" })];
    const result = analyzeChatQuick(messages, [], 30);
    expect(result.uniqueSenders).toBe(1);
  });

  it("finds latest timestamp", () => {
    const messages = [
      msg({ timestamp: "2026-02-06T09:00:00Z" }),
      msg({ timestamp: "2026-02-06T11:00:00Z" }),
      msg({ timestamp: "2026-02-06T10:00:00Z" }),
    ];
    const result = analyzeChatQuick(messages, [], 30);
    expect(result.latestTimestamp).toBe("2026-02-06T11:00:00Z");
  });

  it("counts outbound messages as agent messages", () => {
    const messages = [
      msg({ direction: "outbound" }),
      msg({ direction: "outbound" }),
      msg({ direction: "inbound" }),
      msg({ direction: "inbound" }),
    ];
    const result = analyzeChatQuick(messages, [{ id: "bot1", name: "Dofu" }], 30);
    expect(result.agentSummaries[0].count).toBe(2);
    expect(result.agentSummaries[0].pct).toBe(50);
    expect(result.agentSummaries[0].overThreshold).toBe(true);
  });

  it("counts messages by sender_id matching agent id", () => {
    const messages = [
      msg({ direction: "inbound", sender_id: "bot1" }),
      msg({ direction: "inbound", sender_id: "user1" }),
      msg({ direction: "inbound", sender_id: "user2" }),
      msg({ direction: "inbound", sender_id: "user3" }),
    ];
    const result = analyzeChatQuick(messages, [{ id: "bot1", name: "Dofu" }], 30);
    expect(result.agentSummaries[0].count).toBe(1);
    expect(result.agentSummaries[0].pct).toBe(25);
    expect(result.agentSummaries[0].overThreshold).toBe(false);
  });

  it("marks agent as over threshold when pct > threshold", () => {
    const messages = [
      msg({ direction: "outbound" }),
      msg({ direction: "outbound" }),
      msg({ direction: "inbound" }),
    ];
    // 2/3 = 67% > 30% threshold
    const result = analyzeChatQuick(messages, [{ id: "bot1", name: "Dofu" }], 30);
    expect(result.agentSummaries[0].overThreshold).toBe(true);
  });

  it("handles multiple agents", () => {
    const messages = [
      msg({ direction: "outbound", sender_id: "bot1" }),
      msg({ direction: "inbound", sender_id: "bot2" }),
      msg({ direction: "inbound", sender_id: "user1" }),
    ];
    const agents = [
      { id: "bot1", name: "Dofu" },
      { id: "bot2", name: "Mimi" },
    ];
    const result = analyzeChatQuick(messages, agents, 30);
    expect(result.agentSummaries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// generateDirectives
// ---------------------------------------------------------------------------

describe("generateDirectives", () => {
  it("returns empty array when no current chat", () => {
    const results = [chatResult()];
    expect(generateDirectives(results, undefined, 30)).toEqual([]);
  });

  it("returns empty array when current chat not in results", () => {
    const results = [chatResult({ chatId: "-200" })];
    expect(generateDirectives(results, "-999", 30)).toEqual([]);
  });

  it("generates critical directive when pct > threshold * 1.5", () => {
    const results = [
      chatResult({
        chatId: "-100",
        agentSummaries: [{ name: "Dofu", count: 15, pct: 50, overThreshold: true }],
      }),
    ];
    // threshold=30, 50 > 30*1.5=45 → critical
    const directives = generateDirectives(results, "-100", 30);
    expect(directives.length).toBeGreaterThanOrEqual(1);
    expect(directives[0]).toContain("severely over-exposed");
    expect(directives[0]).toContain("50%");
    expect(directives[0]).toContain("Only reply when directly addressed");
  });

  it("generates moderate directive when pct > threshold but < threshold * 1.5", () => {
    const results = [
      chatResult({
        chatId: "-100",
        agentSummaries: [{ name: "Dofu", count: 8, pct: 40, overThreshold: true }],
      }),
    ];
    // threshold=30, 40 > 30 but 40 < 45 → moderate
    const directives = generateDirectives(results, "-100", 30);
    expect(directives.length).toBeGreaterThanOrEqual(1);
    expect(directives[0]).toContain("over-exposed");
    expect(directives[0]).toContain("Reduce reply frequency");
  });

  it("generates low-presence directive when pct < 10 and totalMessages > 10", () => {
    const results = [
      chatResult({
        chatId: "-100",
        totalMessages: 20,
        agentSummaries: [{ name: "Dofu", count: 1, pct: 5, overThreshold: false }],
      }),
    ];
    const directives = generateDirectives(results, "-100", 30);
    expect(directives.length).toBeGreaterThanOrEqual(1);
    expect(directives[0]).toContain("Low presence");
    expect(directives[0]).toContain("5%");
  });

  it("does NOT generate low-presence when totalMessages <= 10", () => {
    const results = [
      chatResult({
        chatId: "-100",
        totalMessages: 8,
        agentSummaries: [{ name: "Dofu", count: 0, pct: 0, overThreshold: false }],
      }),
    ];
    const directives = generateDirectives(results, "-100", 30);
    expect(directives).toEqual([]);
  });

  it("generates no directive when agent is within normal range", () => {
    const results = [
      chatResult({
        chatId: "-100",
        totalMessages: 20,
        agentSummaries: [{ name: "Dofu", count: 5, pct: 25, overThreshold: false }],
      }),
    ];
    const directives = generateDirectives(results, "-100", 30);
    expect(directives).toEqual([]);
  });

  it("generates cross-field directive when 2+ chats over-exposed", () => {
    const results = [
      chatResult({
        chatId: "-100",
        agentSummaries: [{ name: "Dofu", count: 10, pct: 50, overThreshold: true }],
      }),
      chatResult({
        chatId: "-200",
        name: "Other Chat",
        agentSummaries: [{ name: "Dofu", count: 8, pct: 40, overThreshold: true }],
      }),
    ];
    const directives = generateDirectives(results, "-999", 30);
    expect(directives.some((d) => d.includes("Over-exposed in 2 chats"))).toBe(true);
  });

  it("generates timing directive when 3+ chats active", () => {
    const results = [
      chatResult({ chatId: "-100", totalMessages: 10 }),
      chatResult({ chatId: "-200", totalMessages: 8 }),
      chatResult({ chatId: "-300", totalMessages: 5 }),
    ];
    const directives = generateDirectives(results, undefined, 30);
    expect(directives.some((d) => d.includes("3 language fields active"))).toBe(true);
    expect(directives.some((d) => d.includes("Stagger responses"))).toBe(true);
  });

  it("does NOT generate timing directive when < 3 active chats", () => {
    const results = [
      chatResult({ chatId: "-100", totalMessages: 10 }),
      chatResult({ chatId: "-200", totalMessages: 8 }),
    ];
    const directives = generateDirectives(results, undefined, 30);
    expect(directives.some((d) => d.includes("language fields active"))).toBe(false);
  });

  it("matches current chat by partial chatId inclusion", () => {
    const results = [
      chatResult({
        chatId: "-100",
        totalMessages: 20,
        agentSummaries: [{ name: "Dofu", count: 1, pct: 5, overThreshold: false }],
      }),
    ];
    // currentChatId includes the chatId
    const directives = generateDirectives(results, "telegram:-100:group", 30);
    expect(directives.some((d) => d.includes("Low presence"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatBriefing
// ---------------------------------------------------------------------------

describe("formatBriefing", () => {
  it("includes header and footer tags", () => {
    const results = [chatResult({ totalMessages: 10, uniqueSenders: 3 })];
    const text = formatBriefing(defaultConfig, results);
    expect(text).toContain("[Warroom Briefing");
    expect(text).toContain("[/Warroom Briefing]");
  });

  it("formats a single chat line", () => {
    const results = [
      chatResult({
        name: "思考者咖啡群",
        channel: "telegram",
        totalMessages: 42,
        uniqueSenders: 7,
        agentSummaries: [{ name: "Dofu", count: 10, pct: 24, overThreshold: false }],
      }),
    ];
    const text = formatBriefing(defaultConfig, results);
    expect(text).toContain("思考者咖啡群 (telegram): 42 msgs, 7 people | Dofu 24%");
  });

  it("marks current chat", () => {
    const results = [chatResult({ chatId: "-100", name: "My Chat" })];
    const text = formatBriefing(defaultConfig, results, "-100");
    expect(text).toContain("<-- current");
  });

  it("does not mark non-current chat", () => {
    const results = [chatResult({ chatId: "-100" })];
    const text = formatBriefing(defaultConfig, results, "-200");
    expect(text).not.toContain("<-- current");
  });

  it("shows OVER-EXPOSED label", () => {
    const results = [
      chatResult({
        agentSummaries: [{ name: "Dofu", count: 15, pct: 50, overThreshold: true }],
      }),
    ];
    const text = formatBriefing(defaultConfig, results);
    expect(text).toContain("OVER-EXPOSED");
  });

  it("includes directives when threshold exceeded", () => {
    const results = [
      chatResult({
        chatId: "-100",
        agentSummaries: [{ name: "Dofu", count: 15, pct: 50, overThreshold: true }],
      }),
    ];
    const text = formatBriefing(defaultConfig, results, "-100");
    expect(text).toContain("DIRECTIVE:");
  });

  it("formats multiple chats", () => {
    const results = [
      chatResult({ chatId: "-100", name: "Chat A", channel: "telegram" }),
      chatResult({ chatId: "-200", name: "Chat B", channel: "line" }),
    ];
    const text = formatBriefing(defaultConfig, results);
    expect(text).toContain("Chat A (telegram)");
    expect(text).toContain("Chat B (line)");
  });

  it("uses config threshold (not hardcoded)", () => {
    const config: WarroomConfig = { ...defaultConfig, agent_visibility_threshold: 10 };
    const results = [
      chatResult({
        chatId: "-100",
        agentSummaries: [{ name: "Dofu", count: 3, pct: 15, overThreshold: true }],
      }),
    ];
    const text = formatBriefing(config, results, "-100");
    expect(text).toContain("15% vs 10% limit");
  });
});

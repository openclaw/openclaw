import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { evaluateAndApplyThinkingEscalation } from "./thinking-escalation.js";

describe("evaluateAndApplyThinkingEscalation", () => {
  const createMockSessionEntry = (): SessionEntry => ({
    sessionId: "test-session-id",
    updatedAt: Date.now(),
  });

  const createMockConfig = (
    enabled: boolean,
    thresholds?: Array<{ atContextPercent: number; thinking: ThinkLevel }>,
  ): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          thinkingEscalation: {
            enabled,
            thresholds,
          },
        },
      },
    }) as OpenClawConfig;

  const createMockStore = (): Record<string, SessionEntry> => ({});

  const mockUpdateSessionStoreEntry = async (): Promise<SessionEntry | null> => null;

  it("should not escalate when session is missing", async () => {
    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true),
      sessionEntry: undefined,
      sessionStore: {},
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 50000,
      currentThinkLevel: "off",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(false);
  });

  it("should not escalate when escalation is disabled", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(false),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 90000,
      currentThinkLevel: "off",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(false);
  });

  it("should not escalate when context usage data is missing", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: undefined,
      totalTokens: 50000,
      currentThinkLevel: "off",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(false);
  });

  it("should escalate when context usage exceeds threshold", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();
    store["test"] = entry;

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, [{ atContextPercent: 70, thinking: "high" }]),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 75000, // 75% usage
      currentThinkLevel: "low",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(true);
    expect(result.newLevel).toBe("high");
    expect(result.previousLevel).toBe("low");
    expect(entry.thinkingLevel).toBe("high");
    expect(store["test"].thinkingLevel).toBe("high");
  });

  it("should not downgrade when current level is already higher", async () => {
    const entry = createMockSessionEntry();
    entry.thinkingLevel = "high";
    const store = createMockStore();
    store["test"] = entry;

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, [{ atContextPercent: 70, thinking: "medium" }]),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 75000, // 75% usage
      currentThinkLevel: "high",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(false);
    expect(entry.thinkingLevel).toBe("high"); // unchanged
  });

  it("should use highest applicable threshold", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();
    store["test"] = entry;

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, [
        { atContextPercent: 50, thinking: "medium" },
        { atContextPercent: 75, thinking: "high" },
        { atContextPercent: 90, thinking: "xhigh" },
      ]),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 80000, // 80% usage - should trigger high (75%), not medium (50%)
      currentThinkLevel: "low",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(true);
    expect(result.newLevel).toBe("high");
  });

  it("should handle multiple thresholds correctly when at high usage", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();
    store["test"] = entry;

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, [
        { atContextPercent: 50, thinking: "medium" },
        { atContextPercent: 75, thinking: "high" },
        { atContextPercent: 90, thinking: "xhigh" },
      ]),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 95000, // 95% usage - should trigger xhigh (90%)
      currentThinkLevel: "low",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(true);
    expect(result.newLevel).toBe("xhigh");
  });

  it("should clamp context percentage between 0 and 100", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();
    store["test"] = entry;

    // Test over 100%
    const resultOver = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, [{ atContextPercent: 100, thinking: "xhigh" }]),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 150000, // 150% usage
      currentThinkLevel: "off",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(resultOver.didEscalate).toBe(true);
    expect(resultOver.newLevel).toBe("xhigh");
  });

  it("should not escalate when no thresholds are configured", async () => {
    const entry = createMockSessionEntry();
    const store = createMockStore();
    store["test"] = entry;

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, []),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 95000,
      currentThinkLevel: "off",
      updateSessionStoreEntry: mockUpdateSessionStoreEntry,
    });

    expect(result.didEscalate).toBe(false);
  });

  it("should update session entry in store when escalation occurs", async () => {
    const entry = createMockSessionEntry();
    entry.thinkingLevel = "minimal";
    const store: Record<string, SessionEntry> = { test: entry };
    let updatedEntry: SessionEntry | null = null;

    const mockUpdateFn = async (params: {
      storePath: string;
      sessionKey: string;
      update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
    }): Promise<SessionEntry | null> => {
      const patch = await params.update(entry);
      if (patch) {
        updatedEntry = { ...entry, ...patch };
        return updatedEntry;
      }
      return null;
    };

    const result = await evaluateAndApplyThinkingEscalation({
      cfg: createMockConfig(true, [{ atContextPercent: 50, thinking: "medium" }]),
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: "test",
      storePath: "/test/store.json",
      contextTokensUsed: 100000,
      totalTokens: 60000,
      currentThinkLevel: "minimal",
      updateSessionStoreEntry: mockUpdateFn,
    });

    expect(result.didEscalate).toBe(true);
    expect(entry.thinkingLevel).toBe("medium");
    expect(updatedEntry?.thinkingLevel).toBe("medium");
  });
});

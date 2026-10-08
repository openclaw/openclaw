import { describe, expect, it, vi } from "vitest";
import { isChatHistoryRetrying, setChatHistoryRetrying } from "./chat-history-state.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

describe("chat recovery presentation ownership", () => {
  it("keeps recovery visible until concurrent history and subscription retries both settle", () => {
    const state = makeChatHost();
    setChatHistoryRetrying(state, "history", true);
    setChatHistoryRetrying(state, "subscription", true);
    setChatHistoryRetrying(state, "subscription", false);
    expect(isChatHistoryRetrying(state)).toBe(true);
    setChatHistoryRetrying(state, "history", false);
    expect(isChatHistoryRetrying(state)).toBe(false);
  });

  it("notifies chrome on recovery changes and rejects replaced conversation or connection state", () => {
    const state = makeChatHost();
    const changed = vi.fn();
    Object.assign(state, { historyRecoveryChanged: changed });
    setChatHistoryRetrying(state, "history", true);
    expect(changed).toHaveBeenCalledOnce();
    expect(isChatHistoryRetrying(state)).toBe(true);
    state.connectionEpoch += 1;
    expect(isChatHistoryRetrying(state)).toBe(false);
    setChatHistoryRetrying(state, "history", true);
    state.sessionKey = "agent:main:replacement";
    expect(isChatHistoryRetrying(state)).toBe(false);
    setChatHistoryRetrying(state, "history", false);
    expect(changed).toHaveBeenCalledTimes(3);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
type SessionKey = string;
import { ReplyChainEnforcer } from "./reply-chain-enforcer.js";

describe("ReplyChainEnforcer", () => {
  let enforcer: ReplyChainEnforcer;
  let injectCalls: Array<{ sessionKey: SessionKey; message: string; reason: string }>;
  let nowMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    injectCalls = [];
    nowMs = 1000000;
    enforcer = new ReplyChainEnforcer(
      {
        enabled: true,
        timeoutMs: 30000,
        prompt: `[System] Reply chain broken (stall detected). Resume any promised assignments, or respond with ${SILENT_REPLY_TOKEN} if you need a reply from the user.`,
      },
      {
        nowMs: () => nowMs,
        injectSystemMessage: async (opts) => {
          injectCalls.push(opts);
        },
      },
    );
  });

  afterEach(() => {
    enforcer.stopAll();
    vi.useRealTimers();
  });

  it("should call injectSystemMessage (not runHeartbeatOnce) on stall", () => {
    const sessionKey = "agent:main:discord:channel:123" as SessionKey;

    // Agent sends a message that doesn't end with NO_REPLY → arms
    enforcer.onChatFinal(sessionKey, "I'll check on that for you.");

    // Advance past timeout
    nowMs += 31000;
    vi.advanceTimersByTime(31000);

    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].sessionKey).toBe(sessionKey);
    expect(injectCalls[0].reason).toBe("watchdog-stall");
    expect(injectCalls[0].message).toContain("Reply chain broken");
  });

  it("should NOT fire on sessions that sign off with NO_REPLY", () => {
    const sessionKey = "agent:main:discord:channel:123" as SessionKey;

    enforcer.onChatFinal(sessionKey, "NO_REPLY");

    nowMs += 31000;
    vi.advanceTimersByTime(31000);

    expect(injectCalls).toHaveLength(0);
  });

  it("should NOT fire on sessions that sign off with HEARTBEAT_OK", () => {
    const sessionKey = "agent:main:main" as SessionKey;

    enforcer.onChatFinal(sessionKey, "HEARTBEAT_OK");

    nowMs += 31000;
    vi.advanceTimersByTime(31000);

    expect(injectCalls).toHaveLength(0);
  });

  it("should disarm on delta (streaming proof of life)", () => {
    const sessionKey = "agent:main:discord:channel:123" as SessionKey;

    enforcer.onChatFinal(sessionKey, "Working on it...");

    // Delta arrives before timeout
    nowMs += 10000;
    vi.advanceTimersByTime(10000);
    enforcer.onChatDelta(sessionKey);

    // Advance past original timeout
    nowMs += 25000;
    vi.advanceTimersByTime(25000);

    expect(injectCalls).toHaveLength(0);
  });

  it("should not re-arm from recovery run response", () => {
    const sessionKey = "agent:main:discord:channel:123" as SessionKey;

    // Trigger stall
    enforcer.onChatFinal(sessionKey, "I'll look into it.");
    nowMs += 31000;
    vi.advanceTimersByTime(31000);
    expect(injectCalls).toHaveLength(1);

    // Recovery run responds — should NOT re-arm
    enforcer.onChatFinal(sessionKey, "Here's what I found.");
    nowMs += 31000;
    vi.advanceTimersByTime(31000);

    // Should still be 1 — no second trigger
    expect(injectCalls).toHaveLength(1);
  });

  it("should inject into the stalled session, not main", () => {
    const discordSession = "agent:main:discord:channel:456" as SessionKey;
    const mainSession = "agent:main:main" as SessionKey;

    // Discord session stalls
    enforcer.onChatFinal(discordSession, "Delegating to Hacker...");
    nowMs += 31000;
    vi.advanceTimersByTime(31000);

    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].sessionKey).toBe(discordSession);
    // NOT mainSession — this is the key regression test
    expect(injectCalls[0].sessionKey).not.toBe(mainSession);
  });
});

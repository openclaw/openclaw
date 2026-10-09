/**
 * Covers the process-wide channel bot-pair loop guard shared by turn adapters.
 */
import { describe, expect, it } from "vitest";
import { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";

describe("recordChannelBotPairLoopAndCheckSuppression", () => {
  it("reports the later conversation deadline through the shared guard", () => {
    // Same scenario as the runtime regression, but against the module-level
    // guard adapters actually share and the real seconds-to-milliseconds
    // config resolution: pair limit 1, conversation limit 4, 5s cooldown.
    const facts = {
      scopeId: "bot-loop-protection-latest-active-cooldown",
      conversationId: "conversation-1",
      receiverId: "self",
      defaultEnabled: true,
      config: {
        enabled: true,
        maxEventsPerWindow: 1,
        windowSeconds: 60,
        cooldownSeconds: 5,
        maxConversationBotEvents: 4,
      },
    };
    const record = (senderId: string, eventId: string, nowMs: number) =>
      recordChannelBotPairLoopAndCheckSuppression({ ...facts, senderId, eventId, nowMs });

    expect(record("bot-a", "a1", 0)).toEqual({ suppressed: false });
    expect(record("bot-a", "a2", 1)).toEqual({ suppressed: true, cooldownUntilMs: 5_001 });
    expect(record("bot-b", "b1", 2)).toEqual({ suppressed: false });
    expect(record("bot-b", "b2", 3)).toEqual({ suppressed: true, cooldownUntilMs: 5_003 });
    // Diagnostics render this as the remaining suppression window, so the
    // 5_001 pair deadline would tell operators the storm clears 3ms early.
    expect(record("bot-a", "a3", 4)).toEqual({ suppressed: true, cooldownUntilMs: 5_004 });
  });
});

import { describe, it, expect, vi } from "vitest";
import { resolveAnnounceTarget } from "../agents/tools/sessions-announce-target.js";
import * as gatewayCall from "../gateway/call.js";

// Mock dependencies
vi.mock("../gateway/call.js");
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(() => ({ meta: { preferSessionLookupForAnnounceTarget: true } })),
  normalizeChannelId: vi.fn((id) => id),
}));

describe("Phase 2: Delivery Context Priority Fix", () => {
  it("should prioritize requesterSessionKey (Current) over stored deliveryContext (Stale)", async () => {
    // Scenario: User was on Telegram (Stale), now on Web (Current).
    // Stored session has Telegram info.
    // Requester (Soyul) is on Web.

    const staleTelegramSession = {
      key: "user-123",
      deliveryContext: {
        channel: "telegram",
        to: "chat-123",
      },
      lastChannel: "telegram",
      lastTo: "chat-123",
    };

    // Mock callGateway to return stale session
    vi.mocked(gatewayCall.callGateway).mockResolvedValue({
      sessions: [staleTelegramSession],
    });

    const result = await resolveAnnounceTarget({
      sessionKey: "user-123", // Target User
      displayKey: "user-123",
      requesterSessionKey: "web:group:user-123", // Origin is WEB
    });

    // EXPECTATION: Should return WEB (Current), not Telegram (Stale)
    // Currently this will likely fail and return Telegram.
    expect(result).toEqual({
      channel: "web",
      to: "group:user-123", // parsed from requester key
      accountId: undefined,
    });
  });
});

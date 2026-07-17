import { describe, expect, it, vi } from "vitest";
import type { ConversationIdentity } from "../config/sessions/conversation-identity.js";
import { runGatewayConversationList } from "./conversation-list.js";

describe("runGatewayConversationList", () => {
  it("discovers a trusted directory peer without creating a session", async () => {
    let discovered: ConversationIdentity[] = [];
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "peer-id-123", name: "Friendly Lobster", handle: "@molty" },
    ]);
    const resolveOutboundSessionRoute = vi.fn(async () => ({
      sessionKey: "agent:main:reef:direct:peer-id-123",
      baseSessionKey: "agent:main:reef:direct:peer-id-123",
      peer: { kind: "direct" as const, id: "peer-id-123" },
      chatType: "direct" as const,
      from: "reef:peer-id-123",
      to: "reef:peer-id-123",
    }));
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "reef",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        directory: { listPeers, listGroups: async () => [] },
      })),
      resolveOutboundSessionRoute,
      registerConversationAddresses: vi.fn((_scope, identities) => {
        discovered = [...identities];
      }),
      listConversations: vi.fn(() =>
        discovered.map((identity) => ({
          conversationRef: identity.conversationRef,
          channel: identity.channel,
          accountId: identity.accountId,
          kind: identity.kind,
          target: identity.deliveryTarget,
          label: identity.label,
          firstSeenAt: 100,
          lastSeenAt: 100,
        })),
      ),
    };

    const result = await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "reef", query: "@molty", limit: 50 },
      deps as never,
    );

    expect(listPeers).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", query: "@molty", limit: 50 }),
    );
    expect(deps.listConversations).toHaveBeenCalledWith({ agentId: "main" }, { channel: "reef" });
    expect(resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "reef",
        agentId: "main",
        accountId: "default",
        target: "peer-id-123",
        resolvedTarget: {
          to: "peer-id-123",
          kind: "user",
          display: "Friendly Lobster",
          source: "directory",
          resolutionSource: "directory",
        },
      }),
    );
    expect(result.conversations).toEqual([
      expect.objectContaining({
        conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/u),
        channel: "reef",
        accountId: "default",
        kind: "direct",
        target: "reef:peer-id-123",
        label: "Friendly Lobster",
      }),
    ]);
    expect(result.conversations[0]).not.toHaveProperty("sessionId");
  });
});

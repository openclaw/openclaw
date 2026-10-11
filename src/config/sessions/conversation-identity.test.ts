import { describe, expect, it } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  buildConversationIdentity,
  conversationIdentityFromMsgContext,
  conversationIdentityFromSessionEntry as conversationIdentityFromCanonicalSessionEntry,
} from "./conversation-identity.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastAccountId?: string;
  lastChannel?: string;
};

function conversationIdentityFromSessionEntry(entry: LegacyDeliveryFixture) {
  return conversationIdentityFromCanonicalSessionEntry(normalizeLegacySessionEntryDelivery(entry));
}

function directEntry(peer: string) {
  return {
    sessionId: "session-main",
    updatedAt: 100,
    chatType: "direct" as const,
    deliveryContext: {
      channel: "reef",
      accountId: "default",
      to: `reef:${peer}`,
    },
    origin: {
      provider: "reef",
      accountId: "default",
      nativeDirectUserId: peer,
    },
  };
}

describe("conversation identity", () => {
  it("does not present a stripped peer id as an exact delivery target", () => {
    expect(
      conversationIdentityFromSessionEntry({
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "channel",
        channel: "discord",
        groupId: "ops-room",
      }),
    ).toBeNull();
  });

  it("keeps a paired canonical outbound peer separate from its delivery alias", () => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: {
        channel: "discord",
        accountId: "default",
        to: "user:delivery-alias-456",
      },
      origin: {
        provider: "discord",
        accountId: "default",
        chatType: "direct",
        from: "discord:canonical-peer-123",
        to: "user:delivery-alias-456",
        nativeDirectUserId: "canonical-peer-123",
      },
    });

    expect(identity).toMatchObject({
      channel: "discord",
      deliveryTarget: "user:delivery-alias-456",
      nativeDirectUserId: "canonical-peer-123",
      peerId: "canonical-peer-123",
    });
    expect(identity?.conversationRef).toBe(
      buildConversationIdentity({
        channel: "discord",
        accountId: "default",
        kind: "direct",
        peerId: "canonical-peer-123",
        deliveryTarget: "user:delivery-alias-456",
      })?.conversationRef,
    );
  });

  it("keeps fallback origin targets paired with their origin channel", () => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      channel: "discord",
      origin: {
        provider: "reef",
        accountId: "work",
        from: "reef:peer-b",
      },
    });

    expect(identity).toMatchObject({
      accountId: "work",
      channel: "reef",
      deliveryTarget: "reef:peer-b",
      peerId: "peer-b",
    });
  });

  it("derives live direct identity from the exact reply target, not native metadata", () => {
    const identity = conversationIdentityFromMsgContext({
      ctx: {
        Provider: "reef",
        ChatType: "direct",
        From: "reef:peer-b",
        OriginatingTo: "reef:self",
        NativeDirectUserId: "peer-a",
      },
    });

    expect(identity).toMatchObject({
      deliveryTarget: "reef:peer-b",
      nativeDirectUserId: "peer-a",
      peerId: "peer-b",
    });
    expect(identity?.conversationRef).toBe(
      conversationIdentityFromSessionEntry(directEntry("peer-b"))?.conversationRef,
    );
  });

  it.each(["heartbeat"] as const)(
    "binds synthetic %s metadata to its originating direct route, not its execution sender",
    (source) => {
      const identity = conversationIdentityFromMsgContext({
        ctx: {
          Provider: "reef",
          ChatType: "direct",
          From: "reef:owner",
          To: "reef:owner",
          InternalTurnSource: source,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-b",
          AccountId: "work",
          MessageThreadId: "thread-b",
        },
      });
      expect(identity).toMatchObject({
        kind: "direct",
        accountId: "work",
        deliveryTarget: "reef:peer-b",
        peerId: "peer-b",
        threadId: "thread-b",
      });
    },
  );

  it("derives the same threaded address from live and persisted route facts", () => {
    const persisted = conversationIdentityFromSessionEntry({
      sessionId: "thread-session",
      updatedAt: 100,
      chatType: "channel",
      groupId: "ops-room",
      deliveryContext: {
        channel: "discord",
        accountId: "default",
        to: "channel:ops-room",
        threadId: "user-context",
      },
      origin: { provider: "discord", accountId: "default", nativeChannelId: "ops-room" },
    });
    const live = conversationIdentityFromMsgContext({
      ctx: {
        Provider: "discord",
        AccountId: "default",
        ChatType: "channel",
        From: "discord:channel:ops-room",
        OriginatingTo: "channel:ops-room",
        NativeChannelId: "ops-room",
        MessageThreadId: "user-context",
        ThreadParentId: "unpersisted-parent-id",
      },
      groupResolution: {
        key: "discord:channel:ops-room",
        channel: "discord",
        id: "ops-room",
        chatType: "channel",
      },
    });

    expect(live?.conversationRef).toBe(persisted?.conversationRef);
    expect(live?.deliveryTarget).toBe("channel:ops-room");
    expect(persisted?.deliveryTarget).toBe("channel:ops-room");
    expect(live?.parentConversationRef).toBeUndefined();
  });
});

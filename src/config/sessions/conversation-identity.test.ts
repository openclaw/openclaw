import { expect, it } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { conversationIdentityFromMsgContext } from "./conversation-identity-inbound.js";
import { conversationIdentityFromSessionEntry as conversationIdentityFromCanonicalSessionEntry } from "./conversation-identity.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = SessionEntry & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
};

function stored(entry: Omit<LegacyDeliveryFixture, "sessionId" | "updatedAt">) {
  return conversationIdentityFromCanonicalSessionEntry(
    normalizeLegacySessionEntryDelivery({ sessionId: "session-main", updatedAt: 100, ...entry }),
  );
}

const reefPeer = "reef:peer-b";
const channelTarget = "channel:ops-room";
const threadId = "user-context";
const route = (channel: string, to: string, thread?: string): DeliveryContext => ({
  channel,
  to,
  accountId: "default",
  ...(thread ? { threadId: thread } : {}),
});
type Inbound = Parameters<typeof conversationIdentityFromMsgContext>[0];
const liveIdentity = (ctx: Inbound["ctx"], groupResolution?: Inbound["groupResolution"]) =>
  conversationIdentityFromMsgContext({
    ctx: { Provider: "reef", ChatType: "direct", ...ctx },
    groupResolution,
  });

it("does not present a stripped peer id as an exact delivery target", () => {
  expect(
    stored({
      chatType: "channel",
      channel: "discord",
      groupId: "ops-room",
    }),
  ).toBeNull();
});

it("keeps a paired canonical outbound peer separate from its delivery alias", () => {
  const identity = stored({
    chatType: "direct",
    deliveryContext: route("discord", "user:delivery-alias-456"),
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
    conversationRef: "conv_a97f28e8d3dd98471fb5d4127b1e8635",
    channel: "discord",
    deliveryTarget: "user:delivery-alias-456",
    nativeDirectUserId: "canonical-peer-123",
    peerId: "canonical-peer-123",
  });
});

it("keeps fallback origin targets paired with their origin channel", () => {
  const identity = stored({
    chatType: "direct",
    channel: "discord",
    origin: { provider: "reef", accountId: "work", from: reefPeer },
  });

  expect(identity).toMatchObject({
    accountId: "work",
    channel: "reef",
    deliveryTarget: reefPeer,
    peerId: "peer-b",
  });
});

it.each([
  {
    name: "live sender overrides native metadata",
    ctx: { From: reefPeer, OriginatingTo: "reef:self", NativeDirectUserId: "peer-a" },
    expected: {
      nativeDirectUserId: "peer-a",
      conversationRef: stored({
        chatType: "direct",
        deliveryContext: route("reef", reefPeer),
        origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-b" },
      })?.conversationRef,
    },
  },
  {
    name: "synthetic heartbeat uses the originating route, not its execution sender",
    ctx: {
      From: "reef:owner",
      To: "reef:owner",
      InternalTurnSource: "heartbeat",
      OriginatingChannel: "reef",
      OriginatingTo: reefPeer,
      AccountId: "work",
      MessageThreadId: "thread-b",
    },
    expected: { kind: "direct", accountId: "work", threadId: "thread-b" },
  },
] satisfies {
  name: string;
  ctx: Inbound["ctx"];
  expected: Partial<NonNullable<ReturnType<typeof liveIdentity>>>;
}[])("$name", ({ ctx, expected }) => {
  expect(liveIdentity(ctx)).toMatchObject({
    deliveryTarget: reefPeer,
    peerId: "peer-b",
    ...expected,
  });
});

it("derives the same threaded address from live and persisted route facts", () => {
  const persisted = stored({
    chatType: "channel",
    groupId: "ops-room",
    deliveryContext: route("discord", channelTarget, threadId),
    origin: { provider: "discord", accountId: "default", nativeChannelId: "ops-room" },
  });
  const live = liveIdentity(
    {
      Provider: "discord",
      AccountId: "default",
      ChatType: "channel",
      From: "discord:channel:ops-room",
      OriginatingTo: channelTarget,
      NativeChannelId: "ops-room",
      MessageThreadId: threadId,
      ThreadParentId: "unpersisted-parent-id",
    },
    {
      key: "discord:channel:ops-room",
      channel: "discord",
      id: "ops-room",
      chatType: "channel",
    },
  );

  expect(live).toMatchObject({
    conversationRef: persisted?.conversationRef,
    deliveryTarget: channelTarget,
  });
  expect(persisted).toMatchObject({ deliveryTarget: channelTarget });
  expect(live?.parentConversationRef).toBeUndefined();
});

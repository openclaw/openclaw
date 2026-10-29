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

const defaults = { sessionId: "session-main", updatedAt: 100, chatType: "direct" as const };
const stored = (entry: Omit<LegacyDeliveryFixture, "sessionId" | "updatedAt">) =>
  conversationIdentityFromCanonicalSessionEntry(
    normalizeLegacySessionEntryDelivery({ ...defaults, ...entry }),
  );

const reefPeer = "reef:peer-b";
const discordOrigin = { provider: "discord", accountId: "default" };
const channelTarget = "channel:ops-room";
const threadId = "user-context";
const route = (channel: string, to: string, thread?: string): DeliveryContext => ({
  channel,
  to,
  accountId: "default",
  threadId: thread,
});
type Inbound = Parameters<typeof conversationIdentityFromMsgContext>[0];
const liveIdentity = (ctx: Inbound["ctx"], groupResolution?: Inbound["groupResolution"]) =>
  conversationIdentityFromMsgContext({
    ctx: { Provider: "reef", ChatType: "direct", ...ctx },
    groupResolution,
  });

it("rejects a peer id without an exact delivery target", () => {
  expect(stored({ chatType: "channel", channel: "discord", groupId: "ops-room" })).toBeNull();
});

it("keeps the canonical outbound peer separate from its alias", () => {
  const identity = stored({
    deliveryContext: route("discord", "user:delivery-alias-456"),
    origin: {
      ...discordOrigin,
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
      conversationRef: "conv_2a52ef1ffbd704d8b49729e7527e331c",
    },
  },
  {
    name: "heartbeat uses the origin, not execution sender",
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
] as const)("$name", ({ ctx, expected }) => {
  expect(liveIdentity(ctx)).toMatchObject({
    deliveryTarget: reefPeer,
    peerId: "peer-b",
    ...expected,
  });
});

it("matches live and persisted thread addresses", () => {
  const persisted = stored({
    chatType: "channel",
    groupId: "ops-room",
    deliveryContext: route("discord", channelTarget, threadId),
    origin: { ...discordOrigin, nativeChannelId: "ops-room" },
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

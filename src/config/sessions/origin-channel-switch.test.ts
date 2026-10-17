import { expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { projectLastRoutePatch } from "./metadata-projection.js";
import { deriveSessionMetaPatch, prepareSessionMetaPatch } from "./metadata.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

const sessionKey = "agent:user";
const directTurn = (provider: string, account: string, from: string, to = from) =>
  ({
    Provider: provider,
    Surface: provider,
    ChatType: "direct",
    AccountId: account,
    From: from,
    To: to,
  }) satisfies Partial<MsgContext>;
const telegramPeer = (id: string) => directTurn("telegram", "sample-bot", `telegram:${id}`);

type ProjectedSessionEntry = SessionEntry & { origin?: SessionOrigin };

function applyOrigin(
  existing: SessionEntry | undefined,
  ctx: Partial<MsgContext>,
): ProjectedSessionEntry {
  const patch = deriveSessionMetaPatch({ ctx: ctx as MsgContext, sessionKey, existing });
  const entry = { ...existing, ...patch } as SessionEntry;
  return { ...entry, origin: sessionDeliveryOrigin(entry) };
}

it("clears confirmed absent portraits without changing the sender origin or permissions", () => {
  const ctx = { ...telegramPeer("1000000001"), Surface: undefined };
  const present = applyOrigin(undefined, {
    ...ctx,
    ConversationAvatar: "/media/inbound/portrait.png",
  });
  const transient = applyOrigin(present, ctx);
  expect(transient.origin?.avatar).toBe(present.origin?.avatar);
  const removed = applyOrigin(transient, { ...ctx, ConversationAvatar: "" });
  expect(removed.origin).toEqual({ ...present.origin, avatar: undefined });
  expect(removed.delivery).toEqual({ ...present.delivery, origin: removed.origin });
  expect(present.origin?.avatar).toBe("/media/inbound/portrait.png");
});

it("drops the old native portrait when a shared main session moves to another peer", () => {
  const first = applyOrigin(undefined, {
    ...telegramPeer("1000000001"),
    ConversationAvatar: "/media/inbound/first-peer.png",
  });
  expect(applyOrigin(first, telegramPeer("1000000002")).origin).toMatchObject({
    avatar: undefined,
    from: "telegram:1000000002",
    nativeDirectUserId: undefined,
  });
  expect(first.origin?.avatar).toBe("/media/inbound/first-peer.png");
});

const slackTurn = {
  ...directTurn("slack", "slack-team-1", "slack:U0001", "slack:D111SLACK"),
  NativeChannelId: "D111SLACK",
  NativeDirectUserId: "U0001",
  ConversationAvatar: "/media/inbound/slack-avatar.png",
  MessageThreadId: "1700000000.000100",
} satisfies Partial<MsgContext>;

const telegramTurn = {
  ...telegramPeer("42"),
  AccountId: "telegram-bot-1",
};

it.each<[string, Partial<MsgContext>]>([
  ["provider", telegramTurn],
  ["provider without account", { ...telegramTurn, AccountId: undefined }],
  [
    "provider with native identity",
    { ...telegramTurn, NativeChannelId: "C222TG", MessageThreadId: 555 },
  ],
  ["account", directTurn("slack", "slack-team-2", "slack:U0002", "slack:D222SLACK")],
  ["surface", { ...slackTurn, Surface: "slack-canvas", To: "slack:D222SLACK" }],
])("replaces stale channel identity after a %s change", (name, turn) => {
  const { NativeChannelId: channel, MessageThreadId: thread } = turn;
  const afterSlack = applyOrigin(undefined, slackTurn);
  expect(afterSlack.origin).toMatchObject({
    ...slackIdentity,
    avatar: "/media/inbound/slack-avatar.png",
  });
  const switched = applyOrigin(afterSlack, turn);
  expect(switched.origin).toMatchObject({
    provider: turn.Surface,
    surface: turn.Surface,
    accountId: turn.AccountId,
    nativeChannelId: channel,
    threadId: thread,
  });
  if (name === "surface") {
    expect(switched.delivery).toMatchObject({
      kind: "external",
      route: { channel: "slack-canvas", target: { to: "slack:D222SLACK" } },
    });
  } else {
    expect(switched.origin).toMatchObject({ nativeDirectUserId: undefined, avatar: undefined });
  }
  expect(applyOrigin(switched, turn).origin).toEqual(switched.origin);
});

const slackIdentity = { nativeChannelId: "D111SLACK", threadId: "1700000000.000100" };
it.each([false, true])("preserves sparse metadata when identity was incomplete=%s", (sparse) => {
  const existing: SessionEntry = sparse
    ? {
        sessionId: "session-1",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", to: "slack:D111SLACK" },
          origin: { provider: "slack", ...slackIdentity },
        }),
      }
    : applyOrigin(undefined, slackTurn);
  const next = applyOrigin(existing, {
    ...slackTurn,
    NativeChannelId: undefined,
    NativeDirectUserId: undefined,
    ConversationAvatar: undefined,
    MessageThreadId: undefined,
  });
  expect(next.origin).toMatchObject({
    surface: "slack",
    accountId: "slack-team-1",
    ...slackIdentity,
  });
});

it("preserves a fresh rich route when the inbound identity switches providers", () => {
  const route = {
    channel: "telegram",
    accountId: "telegram-bot-1",
    target: { to: "chat:42", rawTo: "@forty-two", chatType: "group" as const },
    thread: { id: 456, kind: "topic" as const, source: "turn" as const },
  };
  const patch = projectLastRoutePatch({
    sessionKey,
    existing: applyOrigin(undefined, slackTurn),
    route: structuredClone(route),
    metadata: prepareSessionMetaPatch({ ctx: telegramTurn as MsgContext }),
  });

  expect(patch.delivery).toMatchObject({ kind: "external", route });
});

function buildDirectTurn(
  ctx: Pick<typeof telegramTurn, "Provider" | "Surface" | "AccountId" | "From" | "To"> &
    Pick<MsgContext, "NativeChannelId">,
  conversationId: string,
): MsgContext {
  return buildChannelInboundEventContext({
    channel: ctx.Provider,
    provider: ctx.Provider,
    surface: ctx.Surface,
    accountId: ctx.AccountId,
    messageId: "m-1",
    from: ctx.From,
    sender: { id: ctx.From },
    conversation: {
      kind: "direct",
      id: conversationId,
      ...(ctx.NativeChannelId ? { nativeChannelId: ctx.NativeChannelId } : {}),
    },
    route: { agentId: "main", accountId: ctx.AccountId, routeSessionKey: sessionKey },
    reply: { to: ctx.To },
    message: { rawBody: "hi" },
  }) as MsgContext;
}

it("resets native identity after a real-context channel switch", () => {
  const afterSlack = applyOrigin(undefined, buildDirectTurn(slackTurn, "D111SLACK"));
  expect(afterSlack.origin?.nativeChannelId).toBe("D111SLACK");
  const afterTelegram = applyOrigin(afterSlack, buildDirectTurn(telegramTurn, "42"));
  expect(afterTelegram.origin).toMatchObject({ provider: "telegram", nativeChannelId: undefined });
});

const webchatTurn = {
  Provider: "webchat",
  Surface: "webchat",
  OriginatingChannel: "webchat",
  ChatType: "direct",
} satisfies Partial<MsgContext>;

it.each([
  ["webchat", webchatTurn],
  [
    "same delivery route",
    {
      ...webchatTurn,
      OriginatingChannel: "slack",
      OriginatingTo: slackTurn.To,
      AccountId: slackTurn.AccountId,
      MessageThreadId: slackTurn.MessageThreadId,
      ExplicitDeliverRoute: true,
    },
  ],
  ["heartbeat", { InternalTurnSource: "heartbeat", ChatType: "direct" }],
  [
    "cron",
    {
      InternalTurnSource: "cron",
      ChatType: "direct",
      From: "cron:job_REDACTED",
      To: "cron:job_REDACTED",
    },
  ],
] satisfies Array<[string, Partial<MsgContext>]>)(
  "preserves the bound identity through %s until a real channel switch",
  (_name, turn) => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    const afterInternal = applyOrigin(afterSlack, turn);
    expect([afterInternal.origin, afterInternal.delivery]).toEqual([
      afterSlack.origin,
      afterSlack.delivery,
    ]);
    const afterTelegram = applyOrigin(afterInternal, telegramTurn);
    expect(afterTelegram.origin).toMatchObject({
      provider: "telegram",
      nativeChannelId: undefined,
      threadId: undefined,
    });
  },
);

it("adopts an explicitly different external destination from an internal caller", () => {
  const afterSlack = applyOrigin(undefined, slackTurn);
  const afterWebchat = applyOrigin(afterSlack, {
    ...webchatTurn,
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:42",
    AccountId: "telegram-bot-1",
    ExplicitDeliverRoute: true,
  });

  expect(afterWebchat).toMatchObject({
    origin: { provider: "telegram", to: "telegram:42", nativeChannelId: undefined },
    delivery: {
      kind: "external",
      context: { channel: "telegram", to: "telegram:42", accountId: "telegram-bot-1" },
    },
  });
});

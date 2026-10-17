import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { projectLastRoutePatch } from "./metadata-projection.js";
import { deriveSessionMetaPatch, prepareSessionMetaPatch } from "./metadata.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

const sessionKey = "agent:user";
const telegramPeer = (id: string): Partial<MsgContext> => ({
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
  AccountId: "sample-bot",
  From: `telegram:${id}`,
  To: `telegram:${id}`,
});

type ProjectedSessionEntry = SessionEntry & { origin?: SessionOrigin };

function applyOrigin(
  existing: SessionEntry | undefined,
  ctx: Partial<MsgContext>,
): ProjectedSessionEntry {
  const patch = deriveSessionMetaPatch({
    ctx: ctx as MsgContext,
    sessionKey,
    existing,
  });
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
  Provider: "slack",
  Surface: "slack",
  ChatType: "direct",
  From: "slack:U0001",
  To: "slack:D111SLACK",
  NativeChannelId: "D111SLACK",
  NativeDirectUserId: "U0001",
  ConversationAvatar: "/media/inbound/slack-avatar.png",
  AccountId: "slack-team-1",
  MessageThreadId: "1700000000.000100",
} satisfies Partial<MsgContext>;

const telegramTurn = {
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
  From: "telegram:42",
  To: "telegram:42",
  AccountId: "telegram-bot-1",
} satisfies Partial<MsgContext>;

describe("session origin across a channel switch", () => {
  it.each([
    { name: "provider", turn: telegramTurn, channel: undefined, thread: undefined },
    {
      name: "provider without account",
      turn: { ...telegramTurn, AccountId: undefined },
      channel: undefined,
      thread: undefined,
    },
    {
      name: "provider with native identity",
      turn: { ...telegramTurn, NativeChannelId: "C222TG", MessageThreadId: 555 },
      channel: "C222TG",
      thread: 555,
    },
    {
      name: "account",
      turn: {
        ChatType: "direct",
        Provider: "slack",
        Surface: "slack",
        From: "slack:U0002",
        To: "slack:D222SLACK",
        AccountId: "slack-team-2",
      },
      channel: undefined,
      thread: undefined,
    },
    {
      name: "surface",
      turn: { ...slackTurn, Surface: "slack-canvas", To: "slack:D222SLACK" },
      channel: "D111SLACK",
      thread: "1700000000.000100",
    },
  ])("replaces stale channel identity after a $name change", ({ name, turn, channel, thread }) => {
    const afterSlack = applyOrigin(undefined, slackTurn);
    expect(afterSlack.origin).toMatchObject({
      nativeChannelId: "D111SLACK",
      threadId: "1700000000.000100",
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

  it.each([false, true])("preserves sparse metadata when identity was incomplete=%s", (sparse) => {
    const existing = sparse
      ? ({
          sessionId: "session-1",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "slack", to: "slack:D111SLACK" },
            origin: {
              provider: "slack",
              nativeChannelId: "D111SLACK",
              threadId: "1700000000.000100",
            },
          }),
        } satisfies SessionEntry)
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
      nativeChannelId: "D111SLACK",
      threadId: "1700000000.000100",
    });
  });

  it("preserves a fresh rich route when the inbound identity switches providers", () => {
    const patch = projectLastRoutePatch({
      sessionKey,
      existing: applyOrigin(undefined, slackTurn),
      route: {
        channel: "telegram",
        accountId: "telegram-bot-1",
        target: { to: "chat:42", rawTo: "@forty-two", chatType: "group" },
        thread: { id: 456, kind: "topic", source: "turn" },
      },
      metadata: prepareSessionMetaPatch({ ctx: telegramTurn as MsgContext }),
    });

    expect(patch.delivery).toMatchObject({
      kind: "external",
      route: {
        channel: "telegram",
        target: { to: "chat:42", rawTo: "@forty-two", chatType: "group" },
        thread: { id: 456, kind: "topic", source: "turn" },
      },
    });
  });
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

describe("session origin across a non-delivery turn", () => {
  const webchatTurn = {
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "webchat",
    ChatType: "direct",
  } satisfies Partial<MsgContext>;

  it.each([
    { name: "webchat", turn: webchatTurn },
    {
      name: "same delivery route",
      turn: {
        ...webchatTurn,
        OriginatingChannel: "slack",
        OriginatingTo: slackTurn.To,
        AccountId: slackTurn.AccountId,
        MessageThreadId: slackTurn.MessageThreadId,
        ExplicitDeliverRoute: true,
      },
    },
    { name: "heartbeat", turn: { InternalTurnSource: "heartbeat", ChatType: "direct" } },
    {
      name: "cron",
      turn: {
        InternalTurnSource: "cron",
        ChatType: "direct",
        From: "cron:job_REDACTED",
        To: "cron:job_REDACTED",
      },
    },
  ] satisfies Array<{ name: string; turn: Partial<MsgContext> }>)(
    "preserves the bound identity through $name until a real channel switch",
    ({ turn }) => {
      const afterSlack = applyOrigin(undefined, slackTurn);
      const afterInternal = applyOrigin(afterSlack, turn);
      expect(afterInternal.origin).toEqual(afterSlack.origin);
      expect(afterInternal.delivery).toEqual(afterSlack.delivery);
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

    expect(afterWebchat.origin).toMatchObject({
      provider: "telegram",
      to: "telegram:42",
      nativeChannelId: undefined,
    });
    expect(afterWebchat.delivery).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "telegram:42", accountId: "telegram-bot-1" },
    });
  });
});

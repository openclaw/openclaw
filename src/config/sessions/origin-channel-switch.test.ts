// Session origin must drop the prior channel's identity when a dmScope:"main" session moves
// across providers, so channel-keyed fields do not reference a now-inactive channel.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

const sessionKey = "agent:user";

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
        Provider: "slack",
        Surface: "slack",
        ChatType: "direct",
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
    expect(afterSlack.origin?.nativeChannelId).toBe("D111SLACK");
    expect(afterSlack.origin?.threadId).toBe("1700000000.000100");
    expect(afterSlack.origin?.avatar).toBe("/media/inbound/slack-avatar.png");
    const switched = applyOrigin(afterSlack, turn);
    expect(switched.origin?.provider).toBe(turn.Surface);
    expect(switched.origin?.surface).toBe(turn.Surface);
    expect(switched.origin?.accountId).toBe(turn.AccountId);
    expect(switched.origin?.nativeChannelId).toBe(channel);
    expect(switched.origin?.threadId).toBe(thread);
    if (name === "surface") {
      expect(switched.delivery).toMatchObject({
        kind: "external",
        route: { channel: "slack-canvas", target: { to: "slack:D222SLACK" } },
      });
    } else {
      expect(switched.origin?.nativeDirectUserId).toBeUndefined();
      expect(switched.origin?.avatar).toBeUndefined();
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
      Provider: "slack",
      Surface: "slack",
      ChatType: "direct",
      From: "slack:U0001",
      To: "slack:D111SLACK",
      AccountId: "slack-team-1",
    });
    expect(next.origin).toMatchObject({
      surface: "slack",
      accountId: "slack-team-1",
      nativeChannelId: "D111SLACK",
      threadId: "1700000000.000100",
    });
  });

  it("preserves a fresh rich route when the inbound identity switches providers", () => {
    const patch = deriveLastRoutePatch({
      sessionKey,
      existing: applyOrigin(undefined, slackTurn),
      route: {
        channel: "telegram",
        accountId: "telegram-bot-1",
        target: { to: "chat:42", rawTo: "@forty-two", chatType: "group" },
        thread: { id: 456, kind: "topic", source: "turn" },
      },
      ctx: telegramTurn as MsgContext,
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

function buildDirectTurn(opts: {
  provider: string;
  from: string;
  to: string;
  accountId: string;
  conversationId: string;
  nativeChannelId?: string;
}): MsgContext {
  return buildChannelInboundEventContext({
    channel: opts.provider,
    provider: opts.provider,
    surface: opts.provider,
    accountId: opts.accountId,
    messageId: "m-1",
    from: opts.from,
    sender: { id: opts.from },
    conversation: {
      kind: "direct",
      id: opts.conversationId,
      ...(opts.nativeChannelId ? { nativeChannelId: opts.nativeChannelId } : {}),
    },
    route: { agentId: "main", accountId: opts.accountId, routeSessionKey: sessionKey },
    reply: { to: opts.to },
    message: { rawBody: "hi" },
  }) as MsgContext;
}

describe("session origin across a channel switch (real inbound-event context builder)", () => {
  const slackCtx = buildDirectTurn({
    provider: "slack",
    from: "slack:U0001",
    to: "slack:D111SLACK",
    accountId: "slack-team-1",
    conversationId: "D111SLACK",
    nativeChannelId: "D111SLACK",
  });
  const telegramCtx = buildDirectTurn({
    provider: "telegram",
    from: "telegram:42",
    to: "telegram:42",
    accountId: "telegram-bot-1",
    conversationId: "42",
  });

  it("resets native identity after a real-context channel switch", () => {
    const afterSlack = applyOrigin(undefined, slackCtx);
    expect(afterSlack.origin?.nativeChannelId).toBe("D111SLACK");
    const afterTelegram = applyOrigin(afterSlack, telegramCtx);
    expect(afterTelegram.origin?.provider).toBe("telegram");
    expect(afterTelegram.origin?.nativeChannelId).toBeUndefined();
  });
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
    { name: "event", turn: { InternalTurnSource: "event", ChatType: "direct" } },
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
      expect(afterInternal.origin).toMatchObject({
        nativeChannelId: "D111SLACK",
        nativeDirectUserId: "U0001",
        accountId: "slack-team-1",
        threadId: "1700000000.000100",
        provider: "slack",
      });
      expect(afterInternal.origin).toEqual(afterSlack.origin);
      expect(afterInternal.delivery).toEqual(afterSlack.delivery);
      const afterTelegram = applyOrigin(afterInternal, telegramTurn);
      expect(afterTelegram.origin?.provider).toBe("telegram");
      expect(afterTelegram.origin?.nativeChannelId).toBeUndefined();
      expect(afterTelegram.origin?.threadId).toBeUndefined();
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

    expect(afterWebchat.origin?.provider).toBe("telegram");
    expect(afterWebchat.origin?.to).toBe("telegram:42");
    expect(afterWebchat.origin?.nativeChannelId).toBeUndefined();
    expect(afterWebchat.delivery).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "telegram:42", accountId: "telegram-bot-1" },
    });
  });
});

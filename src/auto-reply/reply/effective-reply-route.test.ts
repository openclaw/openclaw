// Tests effective reply route selection from context, session, and fallback state.
import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionOrigin } from "../../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";

type EffectiveReplyRouteParams = Parameters<typeof resolveEffectiveReplyRoute>[0];
type EffectiveReplyRouteContext = EffectiveReplyRouteParams["ctx"];
type EffectiveReplyRouteEntry = NonNullable<EffectiveReplyRouteParams["entry"]>;
type LegacyDeliveryFixture = Partial<SessionEntry> & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
};

const ctx = (params: EffectiveReplyRouteContext): EffectiveReplyRouteContext => params;
const entry = (params: LegacyDeliveryFixture): EffectiveReplyRouteEntry =>
  normalizeLegacySessionEntryDelivery(params as SessionEntry);

describe("resolveEffectiveReplyRoute", () => {
  it("uses live origin context for normal providers", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "slack",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:live",
          AccountId: "live-account",
          ChatType: "channel",
        }),
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "whatsapp",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "discord",
      to: "channel:live",
      accountId: "live-account",
      chatType: "channel",
    });
  });

  it.each<EffectiveReplyRouteContext>([
    { Provider: "slack" },
    { InputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" } },
  ])("does not inherit a route without an internal wake source (%j)", (context) => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: context,
        entry: entry({
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "whatsapp",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: undefined,
      to: undefined,
      accountId: undefined,
    });
  });

  it("uses established external route for sessions_send internal webchat handoffs", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
          AccountId: "webchat-account",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceChannel: "webchat",
          },
        }),
        entry: entry({
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
            threadId: "thread:om_123",
          },
          lastChannel: "webchat",
          lastTo: "session:dashboard",
          lastAccountId: "webchat-account",
        }),
      }),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "work",
      inheritedExternalRoute: true,
    });
  });

  it.each([
    {
      name: "trusted explicit metadata",
      thread: { id: "thread:om_123", source: "explicit" as const },
      chatType: "channel" as const,
      expectedThread: { threadId: "thread:om_123", chatType: "channel" },
    },
    {
      name: "session-normalized metadata",
      thread: { id: "thread:stale", source: "session" as const },
      chatType: undefined,
      expectedThread: {},
    },
    {
      name: "unmarked normalized metadata",
      thread: { id: "thread:stale" },
      chatType: undefined,
      expectedThread: {},
    },
  ])("resolves inherited thread trust for $name", ({ thread, chatType, expectedThread }) => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: {
          Provider: "webchat",
          Surface: "webchat",
          InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
        entry: entry({
          route: {
            channel: "feishu",
            accountId: "work",
            target: { to: "user:ou_123", ...(chatType ? { chatType } : {}) },
            thread,
          },
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
            threadId: thread.id,
          },
        }),
      }),
    ).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "work",
      ...expectedThread,
      inheritedExternalRoute: true,
    });
  });

  it("keeps plugin-owned external routes for runtime routability checks", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          deliveryContext: {
            channel: "customer-chat",
            to: "conversation:123",
            accountId: "workspace-a",
          },
        }),
      }),
    ).toEqual({
      channel: "customer-chat",
      to: "conversation:123",
      accountId: "workspace-a",
      inheritedExternalRoute: true,
    });
  });

  it("keeps normal webchat turns on their live route", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
        }),
        entry: entry({
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_123",
            accountId: "work",
          },
        }),
      }),
    ).toEqual({
      channel: "webchat",
      to: "session:dashboard",
      accountId: undefined,
    });
  });

  it("ignores persisted webchat routes for sessions_send handoffs", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:dashboard",
          InputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
          },
        }),
        entry: entry({
          deliveryContext: {
            channel: "webchat",
            to: "session:old-dashboard",
          },
          lastChannel: "webchat",
          lastTo: "session:old-dashboard",
        }),
      }),
    ).toEqual({
      channel: "webchat",
      to: "session:dashboard",
      accountId: undefined,
    });
  });

  it("prefers live origin context for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          InternalTurnSource: "exec",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
          MessageThreadId: 43,
          AccountId: "live-account",
        }),
        entry: entry({
          deliveryContext: {
            channel: "discord",
            to: "channel:persisted",
            accountId: "persisted-account",
          },
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: "live-account",
      threadId: 43,
    });
  });

  it("inherits session delivery for internal wake replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ InternalTurnSource: "exec" }),
        entry: {
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "telegram",
              to: "chat:persisted",
              accountId: "persisted-account",
            },
          }),
        },
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:persisted",
      accountId: "persisted-account",
    });
  });

  it("falls back to legacy last route fields for exec-event replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({ InternalTurnSource: "exec" }),
        entry: entry({
          lastChannel: "slack",
          lastTo: "last-to",
          lastAccountId: "last-account",
        }),
      }),
    ).toEqual({
      channel: "slack",
      to: "last-to",
      accountId: "last-account",
    });
  });

  it("does not inherit an account from a different persisted channel", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          InternalTurnSource: "exec",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
        }),
        entry: entry({
          deliveryContext: {
            channel: "discord",
            to: "channel:persisted",
            accountId: "persisted-account",
          },
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: undefined,
    });
  });

  it("fills a partial exec-event route from the same persisted channel", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: ctx({
          InternalTurnSource: "exec",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat:live",
        }),
        entry: entry({
          chatType: "direct",
          deliveryContext: {
            channel: "telegram",
            to: "chat:persisted",
            accountId: "persisted-account",
          },
        }),
      }),
    ).toEqual({
      channel: "telegram",
      to: "chat:live",
      accountId: "persisted-account",
      chatType: "direct",
    });
  });
});

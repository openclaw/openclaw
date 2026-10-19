import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionOrigin } from "../../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";

type RouteParams = Parameters<typeof resolveEffectiveReplyRoute>[0];
type LegacyDeliveryFixture = Partial<SessionEntry> & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
};

const entry = (params: LegacyDeliveryFixture): NonNullable<RouteParams["entry"]> =>
  normalizeLegacySessionEntryDelivery(params as SessionEntry);

const persisted = { channel: "telegram", to: "chat:persisted", accountId: "persisted-account" };
const discord = { channel: "discord", to: "channel:persisted", accountId: "persisted-account" };
const feishu = { channel: "feishu", to: "user:ou_123", accountId: "work" };
const pluginRoute = { channel: "customer-chat", to: "conversation:123", accountId: "workspace-a" };
const webchat = {
  Provider: "webchat",
  Surface: "webchat",
  OriginatingChannel: "webchat",
  OriginatingTo: "session:dashboard",
};
const handoff = { kind: "inter_session", sourceTool: "sessions_send" } as const;
const live = {
  InternalTurnSource: "exec",
  OriginatingChannel: "telegram",
  OriginatingTo: "chat:live",
} as const;

describe("resolveEffectiveReplyRoute", () => {
  it.each<
    [
      name: string,
      ctx: RouteParams["ctx"],
      stored: LegacyDeliveryFixture,
      expected: ReturnType<typeof resolveEffectiveReplyRoute>,
    ]
  >([
    [
      "does not inherit a route without an internal wake source",
      { InputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" } },
      {
        deliveryContext: persisted,
        lastChannel: "whatsapp",
        lastTo: "last-to",
        lastAccountId: "last-account",
      },
      { channel: undefined, to: undefined, accountId: undefined },
    ],
    [
      "uses established external route for sessions_send internal webchat handoffs",
      {
        ...webchat,
        AccountId: "webchat-account",
        InputProvenance: { ...handoff, sourceChannel: "webchat" },
      },
      {
        deliveryContext: { ...feishu, threadId: "thread:om_123" },
        lastChannel: "webchat",
        lastTo: "session:dashboard",
        lastAccountId: "webchat-account",
      },
      { ...feishu, inheritedExternalRoute: true },
    ],
    [
      "keeps plugin-owned external routes for runtime routability checks",
      { ...webchat, InputProvenance: handoff },
      { deliveryContext: pluginRoute },
      { ...pluginRoute, inheritedExternalRoute: true },
    ],
    [
      "keeps normal webchat turns on their live route",
      webchat,
      { deliveryContext: feishu },
      { channel: "webchat", to: "session:dashboard", accountId: undefined },
    ],
    [
      "prefers live origin context for exec-event replies",
      { ...live, MessageThreadId: 43, AccountId: "live-account" },
      {
        deliveryContext: discord,
        lastChannel: "slack",
        lastTo: "last-to",
        lastAccountId: "last-account",
      },
      { channel: "telegram", to: "chat:live", accountId: "live-account", threadId: 43 },
    ],
    [
      "does not inherit an account from a different persisted channel",
      live,
      { deliveryContext: discord },
      { channel: "telegram", to: "chat:live", accountId: undefined },
    ],
    [
      "fills a partial exec-event route from the same persisted channel",
      live,
      { chatType: "direct", deliveryContext: persisted },
      { channel: "telegram", to: "chat:live", accountId: "persisted-account", chatType: "direct" },
    ],
  ])("%s", (_name, ctx, stored, expected) => {
    expect(
      resolveEffectiveReplyRoute({
        ctx,
        entry: entry(stored),
      }),
    ).toEqual(expected);
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
  ])("resolves inherited thread trust for $name", ({ thread, chatType, expectedThread }) => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: { Provider: "webchat", Surface: "webchat", InputProvenance: handoff },
        entry: entry({
          route: {
            channel: "feishu",
            accountId: "work",
            target: { to: "user:ou_123", ...(chatType ? { chatType } : {}) },
            thread,
          },
          deliveryContext: { ...feishu, threadId: thread.id },
        }),
      }),
    ).toEqual({ ...feishu, ...expectedThread, inheritedExternalRoute: true });
  });

  it("inherits session delivery for internal wake replies", () => {
    expect(
      resolveEffectiveReplyRoute({
        ctx: { InternalTurnSource: "exec" },
        entry: { delivery: normalizeSessionDeliveryState({ context: persisted }) },
      }),
    ).toEqual({ channel: "telegram", to: "chat:persisted", accountId: "persisted-account" });
  });
});

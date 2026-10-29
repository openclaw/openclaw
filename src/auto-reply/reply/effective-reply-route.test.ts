import { expect, it } from "vitest";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";

type Params = Parameters<typeof resolveEffectiveReplyRoute>[0];
const telegram = { channel: "telegram", to: "chat:persisted", accountId: "persisted-account" };
const discord = { channel: "discord", to: "channel:persisted", accountId: "persisted-account" };
const external = { channel: "customer-chat", to: "conversation:123", accountId: "workspace-a" };
const webchat = { Provider: "webchat", OriginatingChannel: "webchat", OriginatingTo: "dashboard" };
const handoff = {
  ...webchat,
  InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
} as const;
const live = {
  InternalTurnSource: "exec",
  OriginatingChannel: "telegram",
  OriginatingTo: "chat:live",
} as const;
const entry = (
  context: DeliveryContext,
  route?: ChannelRouteRef,
): NonNullable<Params["entry"]> => ({
  delivery: normalizeSessionDeliveryState({ context, route }),
});

it.each<
  [
    string,
    Params["ctx"],
    NonNullable<Params["entry"]>,
    ReturnType<typeof resolveEffectiveReplyRoute>,
  ]
>([
  [
    "no internal wake",
    { InputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" } },
    entry(telegram),
    { channel: undefined, to: undefined, accountId: undefined },
  ],
  [
    "handoff keeps plugin-owned external route",
    { ...handoff, AccountId: "webchat-account" },
    entry(external),
    { ...external, inheritedExternalRoute: true },
  ],
  [
    "normal webchat stays live",
    webchat,
    entry(external),
    { channel: "webchat", to: "dashboard", accountId: undefined },
  ],
  [
    "live exec route wins",
    { ...live, MessageThreadId: 43, AccountId: "live-account" },
    entry(discord),
    { channel: "telegram", to: "chat:live", accountId: "live-account", threadId: 43 },
  ],
  [
    "different channel cannot donate account",
    live,
    entry(discord),
    { channel: "telegram", to: "chat:live", accountId: undefined },
  ],
  [
    "same channel fills missing account and chat type",
    live,
    { ...entry(telegram), chatType: "direct" },
    { channel: "telegram", to: "chat:live", accountId: "persisted-account", chatType: "direct" },
  ],
  ["wake inherits whole tuple", { InternalTurnSource: "exec" }, entry(telegram), telegram],
])("%s", (_name, ctx, stored, expected) => {
  expect(resolveEffectiveReplyRoute({ ctx, entry: stored })).toEqual(expected);
});

it.each(["explicit", "session"] as const)("inherits only trusted thread metadata: %s", (source) => {
  const context = {
    channel: "feishu",
    to: "user:ou_123",
    accountId: "work",
    threadId: "thread:123",
  };
  const route: ChannelRouteRef = {
    channel: "feishu",
    accountId: "work",
    target: {
      to: "user:ou_123",
      ...(source === "explicit" ? { chatType: "channel" as const } : {}),
    },
    thread: { id: "thread:123", source },
  };
  expect(resolveEffectiveReplyRoute({ ctx: handoff, entry: entry(context, route) })).toEqual({
    channel: "feishu",
    to: "user:ou_123",
    accountId: "work",
    inheritedExternalRoute: true,
    ...(source === "explicit" ? { threadId: "thread:123", chatType: "channel" } : {}),
  });
});

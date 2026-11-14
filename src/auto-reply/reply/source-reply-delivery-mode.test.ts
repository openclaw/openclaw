import { expect, it } from "vitest";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";

const automaticGroups = { messages: { groupChat: { visibleReplies: "automatic" } } } as const;
const toolReplies = { messages: { visibleReplies: "message_tool" } } as const;
const webchat = { ChatType: "direct", Provider: "webchat", Surface: "webchat" } as const;
type Policy = ReturnType<typeof resolveSourceReplyVisibilityPolicy>;
type Input = Parameters<typeof resolveSourceReplyVisibilityPolicy>[0];
const visible: Policy = {
  sourceReplyDeliveryMode: "automatic",
  sessionStableSourceReplyDeliveryMode: "automatic",
  sendPolicyDenied: false,
  suppressAutomaticSourceDelivery: false,
  suppressDelivery: false,
  suppressHookUserDelivery: false,
  suppressHookReplyLifecycle: false,
  suppressTyping: false,
  deliverySuppressionReason: "",
};
const toolOnly: Policy = {
  ...visible,
  sourceReplyDeliveryMode: "message_tool_only",
  sessionStableSourceReplyDeliveryMode: "message_tool_only",
  suppressAutomaticSourceDelivery: true,
  suppressDelivery: true,
  suppressHookUserDelivery: true,
  deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
};
const turnOnly = { ...toolOnly, sessionStableSourceReplyDeliveryMode: "automatic" } as const;

// The visibility owner calls the mode resolver; checking both layers separately replayed
// the same decisions. Full policies also keep typing, hooks and session stability independent.
it.each([
  ["direct default", {}, visible],
  ["group default", { ctx: { ChatType: "group" } }, visible],
  [
    "progress refresh is silent without changing the session",
    {
      ctx: {
        ...webchat,
        InputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
      },
    },
    {
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
      deliverySuppressionReason: "progress card refresh",
    },
  ],

  [
    "room event overrides an explicit automatic request",
    {
      cfg: automaticGroups,
      ctx: { ChatType: "group", InboundEventKind: "room_event" },
      requested: "automatic",
    },
    turnOnly,
  ],

  [
    "explicit automatic WebChat reply",
    { ctx: { ...webchat, InboundEventKind: "room_event" }, requested: "automatic" },
    visible,
  ],
  [
    "WebChat provider with an external surface",
    {
      cfg: automaticGroups,
      ctx: { ...webchat, ChatType: "group", Surface: "telegram", InboundEventKind: "room_event" },
    },
    turnOnly,
  ],
  [
    "explicit external WebChat route",
    {
      ctx: { ...webchat, InboundEventKind: "room_event", ExplicitDeliverRoute: true },
      requested: "automatic",
    },
    turnOnly,
  ],
  ["internal WebChat config opt-in", { cfg: toolReplies, ctx: webchat }, toolOnly],
  ["internal WebChat explicit opt-in", { ctx: webchat, requested: "message_tool_only" }, toolOnly],
  ["harness default", { defaultVisibleReplies: "message_tool" }, toolOnly],
  [
    "config overrides harness default",
    { cfg: { messages: { visibleReplies: "automatic" } }, defaultVisibleReplies: "message_tool" },
    visible,
  ],
  [
    "group config overrides global mode",
    {
      cfg: {
        messages: { visibleReplies: "message_tool", groupChat: { visibleReplies: "automatic" } },
      },
      ctx: { ChatType: "channel" },
    },
    visible,
  ],
  [
    "authorized command without source",
    {
      cfg: toolReplies,
      ctx: { ChatType: "direct", CommandAuthorized: true, CommandBody: "/reset" },
    },
    visible,
  ],
  [
    "ordinary text mentioning a command",
    {
      cfg: toolReplies,
      ctx: {
        ChatType: "direct",
        CommandAuthorized: true,
        CommandBody: "hey can you /status please",
      },
    },
    toolOnly,
  ],
  [
    "unauthorized legacy slash command",
    {
      ctx: {
        ChatType: "group",
        CommandSource: "text",
        CommandAuthorized: false,
        CommandBody: "/status",
      },
    },
    turnOnly,
  ],
  [
    "authorized structured text command",
    {
      cfg: toolReplies,
      ctx: {
        ChatType: "group",
        CommandTurn: { kind: "text-slash", source: "text", authorized: true, body: "/status" },
      },
    },
    visible,
  ],
  [
    "authorized structured native command",
    {
      cfg: toolReplies,
      ctx: {
        ChatType: "group",
        CommandTurn: { kind: "native", source: "native", authorized: true, body: "/status" },
      },
    },
    visible,
  ],
  [
    "unauthorized structured command",
    {
      cfg: toolReplies,
      ctx: {
        ChatType: "group",
        CommandTurn: { kind: "text-slash", source: "text", authorized: false, body: "/status" },
      },
    },
    toolOnly,
  ],
  ["tool-only group", { cfg: toolReplies, ctx: { ChatType: "group" } }, toolOnly],

  // Sender-scoped availability must not split the CLI binding hash from synthetic turns.
  [
    "sender-scoped message denial",
    { cfg: toolReplies, messageToolAvailable: false, sessionStableMessageToolAvailable: true },
    { sessionStableSourceReplyDeliveryMode: "message_tool_only" },
  ],
  ["session-wide message denial", { cfg: toolReplies, messageToolAvailable: false }, visible],

  [
    "inter-session turn override",
    {
      ctx: {
        ChatType: "direct",
        InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
      },
      requested: "message_tool_only",
    },
    turnOnly,
  ],
  [
    "lifecycle turn override",
    {
      ctx: {
        ChatType: "direct",
        InputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      },
      requested: "message_tool_only",
    },
    turnOnly,
  ],
  [
    "scheduled turn override",
    { scheduledAutomation: true, requested: "message_tool_only" },
    turnOnly,
  ],
  [
    "send-policy denial",
    { ctx: { ChatType: "group" }, sendPolicy: "deny" },
    {
      sendPolicyDenied: true,
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
      deliverySuppressionReason: "sendPolicy: deny",
    },
  ],
  [
    "typing-only suppression",
    { explicitSuppressTyping: true },
    { suppressHookReplyLifecycle: true, suppressTyping: true },
  ],
  [
    "ACP child suppression",
    { suppressAcpChildUserDelivery: true },
    { suppressHookUserDelivery: true, suppressHookReplyLifecycle: true },
  ],
  [
    "unavailable configured message tool",
    { cfg: toolReplies, ctx: { ChatType: "group" }, messageToolAvailable: false },
    visible,
  ],
  [
    "unavailable requested message tool",
    { ctx: { ChatType: "channel" }, requested: "message_tool_only", messageToolAvailable: false },
    visible,
  ],
  [
    "strict mode without a message tool",
    {
      ctx: { ChatType: "channel" },
      requested: "message_tool_only",
      strictMessageToolOnly: true,
      messageToolAvailable: false,
    },
    toolOnly,
  ],
  [
    "strict mode overrides requested automatic delivery",
    {
      cfg: automaticGroups,
      ctx: { ChatType: "channel" },
      requested: "automatic",
      strictMessageToolOnly: true,
    },
    toolOnly,
  ],
] satisfies Array<[string, Partial<Input>, Partial<Policy>]>)("%s", (_name, input, expected) => {
  expect(
    resolveSourceReplyVisibilityPolicy({
      cfg: {},
      ctx: { ChatType: "direct" },
      sendPolicy: "allow",
      ...input,
    }),
  ).toEqual({ ...visible, ...expected });
});

import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TemplateContext } from "../templating.js";
import { prepareReplyConversation } from "./prompt-session-context.js";

const stored: SessionEntry = {
  sessionId: "conversation",
  updatedAt: 1,
  chatType: "channel",
  groupId: "C123",
  subject: "Operations",
  groupChannel: "#ops",
  space: "workspace",
  groupActivation: "always",
  delivery: normalizeSessionDeliveryState({
    context: { channel: "slack", to: "C123", accountId: "work", threadId: "42" },
    origin: { provider: "slack", surface: "slack", chatType: "channel" },
  }),
};
const current: TemplateContext = {
  InternalTurnSource: "exec",
  OriginatingChannel: "slack",
  OriginatingTo: "channel:C123",
  AccountId: "work",
  MessageThreadId: 42,
  ChatType: "channel",
};

it.each([
  ["matching exec", current, true],
  ["heartbeat without a current route", { InternalTurnSource: "heartbeat" }, true],
  ["different channel", { ...current, OriginatingChannel: "discord" }, false],
  ["different target", { ...current, OriginatingTo: "C999" }, false],
  ["different account", { ...current, AccountId: "personal" }, false],
  ["missing account", { ...current, AccountId: undefined }, false],
  ["different thread", { ...current, MessageThreadId: 43 }, false],
  ["missing thread", { ...current, MessageThreadId: undefined }, false],
  ["missing destination", { ...current, OriginatingTo: undefined }, false],
] satisfies Array<[string, TemplateContext, boolean]>)(
  "%s shares room context and activation only for its own conversation",
  (_name: string, input: TemplateContext, inherits: boolean) => {
    const conversation = prepareReplyConversation({ ctx: input, sessionEntry: stored });
    expect(conversation.activation).toBe(inherits ? "always" : undefined);
    expect(conversation.fields).toMatchObject({
      Provider: input.OriginatingChannel ?? "slack",
      ChatType: "channel",
      GroupSubject: inherits ? "Operations" : undefined,
      GroupChannel: inherits ? "#ops" : undefined,
    });
    if (inherits) {
      expect(conversation.fields).toMatchObject({
        OriginatingTo: input.OriginatingTo ?? "C123",
        AccountId: "work",
        MessageThreadId: input.MessageThreadId ?? "42",
      });
    }
  },
);

it("keeps current room text and sender/execution facts on the current context", () => {
  const facts = {
    Body: "current event",
    SenderId: "current-sender",
    WasMentioned: false,
    CommandAuthorized: false,
    SessionKey: "isolated-execution",
  };
  const input = {
    ...current,
    ...facts,
    GroupSubject: "Live operations",
    GroupChannel: "#live",
    GroupSpace: "live workspace",
  };
  const conversation = prepareReplyConversation({ ctx: input, sessionEntry: stored });
  const prompt = { ...input, ...conversation.fields };
  expect(prompt).toMatchObject({
    ...facts,
    GroupSubject: "Live operations",
    GroupChannel: "#live",
    GroupSpace: "live workspace",
  });
  expect(conversation.fields).not.toHaveProperty("SessionKey");
  expect(conversation.fields).not.toHaveProperty("SenderId");
});

it("leaves ordinary user context unchanged despite a different stored room", () => {
  const input: TemplateContext = {
    Provider: "discord",
    Surface: "webchat",
    ChatType: "direct",
    OriginatingChannel: "discord",
    OriginatingTo: "user:current",
    AccountId: "personal",
  };
  const conversation = prepareReplyConversation({ ctx: input, sessionEntry: stored });
  expect(conversation.fields).toMatchObject(input);
  expect(conversation.fields.GroupSubject).toBeUndefined();
});

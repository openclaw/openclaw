import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TemplateContext } from "../templating.js";
import { buildGroupIntro } from "./groups.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";
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

function metadata(ctx: TemplateContext) {
  const json = /```json\n([\s\S]*?)\n```/.exec(buildInboundMetaSystemPrompt(ctx, {}))?.[1];
  expect(json, "rendered inbound metadata").toBeDefined();
  return JSON.parse(json!) as Record<string, unknown>;
}

describe("prepared reply conversation", () => {
  it.each([
    ["matching exec", current, true],
    ["heartbeat without a current route", { InternalTurnSource: "heartbeat" }, true],
    ["cron without a current route", { InternalTurnSource: "cron" }, true],
    ["exec without a current route", { InternalTurnSource: "exec" }, true],
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
      const rendered = buildInboundUserContextPrefix(conversation.fields);
      expect(rendered.includes('"group_subject":"Operations"')).toBe(inherits);
      expect(rendered.includes('"group_channel":"#ops"')).toBe(inherits);
      expect(
        buildGroupIntro({ activation: conversation.activation, defaultActivation: "mention" }),
      ).toContain(inherits ? "Activation: always-on" : "Activation: trigger-only");
      expect(metadata(conversation.fields)).toMatchObject({
        channel: input.OriginatingChannel ?? "slack",
        chat_type: "channel",
      });
      if (inherits) {
        expect(conversation.fields).toMatchObject({
          Provider: "slack",
          ChatType: "channel",
          GroupChannel: "#ops",
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
    const rendered = buildInboundUserContextPrefix(prompt);
    expect(rendered).toContain('"group_subject":"Live operations"');
    expect(rendered).not.toContain('"group_subject":"Operations"');
    expect(prompt).toMatchObject(facts);
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
    expect(metadata(conversation.fields)).toMatchObject({
      channel: "discord",
      provider: "discord",
      surface: "webchat",
      chat_type: "direct",
    });
    expect(buildInboundUserContextPrefix(conversation.fields)).not.toContain("Operations");
  });
});

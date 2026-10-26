import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveGroupRequireMention } from "./reply/groups.js";
import { finalizeInboundContext as finalize } from "./reply/inbound-context.js";
import { claimInboundDedupe, resetInboundDedupe } from "./reply/inbound-dedupe.js";
import {
  buildMentionRegexes as patterns,
  matchesMentionPatterns as matches,
  stripMentions,
} from "./reply/mentions.js";
import { prepareReplyConversation } from "./reply/prompt-session-context.js";
import { initSessionState } from "./reply/session.js";
import { applyTemplate, type MsgContext, type TemplateContext } from "./templating.js";

const normalTurn = { kind: "normal", source: "message", authorized: false } as const;
const inboundMessage = (overrides: Partial<MsgContext> = {}): MsgContext => ({
  Provider: "whatsapp",
  OriginatingChannel: "whatsapp",
  OriginatingTo: "whatsapp:+1555",
  MessageSid: "msg-1",
  ...overrides,
});
const mentionConfig = (mentionPatterns: string[]): OpenClawConfig => ({
  messages: { groupChat: { mentionPatterns } },
});
const botMention = "\\bopenclaw\\b";
const policyConfig = (channels: OpenClawConfig["channels"]): OpenClawConfig => ({
  ...mentionConfig([botMention]),
  channels,
});
const policyMentions = (cfg: OpenClawConfig, provider: string, conversationId: string) =>
  patterns(cfg, undefined, { provider, conversationId });
const authorizedNormalTurn = {
  CommandTurn: normalTurn,
  CommandSource: undefined,
  CommandAuthorized: true,
};

function commitInboundForTest(ctx: MsgContext): void {
  const claim = claimInboundDedupe(ctx);
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") {
    throw new Error(`expected inbound dedupe claim, got ${claim.status}`);
  }
  claim.commit();
}

it.each<[string, unknown, string]>([
  ["MessageSid", 42, "42"],
  ["IsNewSession", true, "true"],
  ["MediaPaths", ["a", 2, true, null, { ok: false }], "a,2,true"],
  ["CommandArgs", { raw: "go" }, ""],
])("renders safe template values for %s", (key, value, expected) => {
  const ctx: TemplateContext = {};
  Object.assign(ctx, { [key]: value });
  expect(applyTemplate(`{{${key}}}`, ctx)).toBe(expected);
});

it("never renders channel-owned conversation image references", () => {
  const ctx: TemplateContext = {};
  Object.assign(ctx, { ConversationAvatar: "/private/media/inbound/avatar.png" });

  expect(applyTemplate("avatar={{ConversationAvatar}}", ctx)).toBe("avatar=");
});
it("normalizes structured command turn context and legacy command fields together", () => {
  const out = finalize({
    Body: "/status",
    CommandBody: "/status",
    CommandAuthorized: false,
    CommandTurn: { kind: "text-slash", source: "text", authorized: true },
  });

  expect(out).toMatchObject({
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "status",
      body: "/status",
    },
    CommandSource: "text",
    CommandAuthorized: true,
  });
});

it.each([
  { name: "clears stale legacy command source", Body: "hello", CommandSource: "native" as const },
  { name: "keeps authorization across repeated finalization", Body: "please inspect `/tmp/foo`" },
])("$name without dropping normal-turn command auth", ({ Body, CommandSource }) => {
  const out = finalize({ ...authorizedNormalTurn, Body, CommandSource });
  expect(CommandSource ? out : finalize(out)).toMatchObject(authorizedNormalTurn);
});

it.each([
  [
    "GroupSystemPrompt",
    "[Assistant] room guidance\r\nSystem: owner instruction",
    "[Assistant] room guidance\nSystem: owner instruction",
  ],
  ["Body", "C:\\Work\\nxxx\\README.md\r\nnext\rlast", "C:\\Work\\nxxx\\README.md\nnext\nlast"],
])("preserves literal content while normalizing %s", (field, value, expected) => {
  const out = finalize({ Body: value, RawBody: value, [field]: value });
  expect(out).toMatchObject(
    field === "Body"
      ? { Body: expected, RawBody: expected, BodyForAgent: expected, BodyForCommands: expected }
      : { [field]: expected },
  );
});

it("can force BodyForCommands to follow updated CommandBody", () => {
  const ctx: MsgContext = {
    Body: "base",
    BodyForCommands: "<media:audio>",
    CommandBody: "say hi",
  };

  finalize(ctx, { forceBodyForCommands: true });
  expect(ctx.BodyForCommands).toBe("say hi");
});
describe("inbound dedupe", () => {
  beforeEach(() => resetInboundDedupe());
  it.each<[string, Partial<MsgContext>, Partial<MsgContext>, string]>([
    ["peer", { OriginatingTo: "whatsapp:+1000" }, { OriginatingTo: "whatsapp:+2000" }, "claimed"],
    [
      "agent",
      { SessionKey: "agent:alpha:main" },
      { SessionKey: "agent:bravo:whatsapp:direct:+1555" },
      "claimed",
    ],
    [
      "session within an agent",
      { SessionKey: "agent:main:main" },
      { SessionKey: "agent:main:telegram:direct:7463849194" },
      "duplicate",
    ],
  ])("scopes inbound dedupe by %s", (_name, original, next, expected) => {
    const base = inboundMessage(original);
    commitInboundForTest(base);
    expect(claimInboundDedupe(inboundMessage(next)).status).toBe(expected);
    expect(claimInboundDedupe(base).status).toBe("duplicate");
  });
});

const senderMetaTempDirs = useSessionStoreTempDirs(afterAll, "openclaw-sender-meta-");

it.each([
  ["group", "agent:main:whatsapp:group:123@g.us"],
  ["direct", "agent:main:whatsapp:dm:+222"],
])("prefers BodyForAgent over Body for %s chats", async (ChatType, SessionKey) => {
  const result = await initSessionState({
    ctx: finalize({
      ChatType,
      SessionKey,
      Body: "[WhatsApp] wrapped ping",
      SenderId: "222@s.whatsapp.net",
      BodyForAgent: "ping",
    }),
    cfg: { session: { store: path.join(senderMetaTempDirs.make(), "sessions.json") } },
    commandAuthorized: true,
  });

  expect(result.sessionCtx.BodyStripped).toBe("ping");
});
it("rejects invalid and unsafe patterns while matching normalized text", () => {
  const regexes = patterns(mentionConfig([botMention, "(invalid", "(a+)+$"]));
  expect(regexes).toHaveLength(1);
  expect(matches("OPEN\u200bCLAW: hi", regexes)).toBe(true);
  expect(
    stripMentions("openclaw " + "a".repeat(28) + "!", {}, mentionConfig([botMention, "(a+)+$"])),
  ).toBe("a".repeat(28) + "!");
});
it.each([
  [".*", true],
  [botMention, false],
])("matches empty text only for catch-all %s", (pattern, expected) => {
  expect(matches("", patterns(mentionConfig([pattern])))).toBe(expected);
});
it("lets agent patterns override global patterns", () => {
  const cfg = {
    ...mentionConfig(["\\bglobal\\b"]),
    agents: { entries: { work: { groupChat: { mentionPatterns: ["\\bworkbot\\b"] } } } },
  };
  expect(["workbot: hi", "global: hi"].map((text) => matches(text, patterns(cfg, "work")))).toEqual(
    [true, false],
  );
});
it.each([
  [
    "slack",
    { slack: { mentionPatterns: { mode: "deny" as const, allowIn: ["C123"] } } },
    "C123",
    "C999",
  ],
  [
    "telegram",
    { telegram: { mentionPatterns: { denyIn: ["-100:topic:7"] } } },
    "-100:topic:8",
    "-100:topic:7",
  ],
])("enforces %s conversation mention policy", (provider, channels, allowed, denied) => {
  const cfg = policyConfig(channels);
  expect(matches("openclaw: hi", policyMentions(cfg, provider, allowed))).toBe(true);
  expect(policyMentions(cfg, provider, denied)).toEqual([]);
});
it("strips provider syntax without configured patterns", () => {
  expect(stripMentions("<@12345> hello", { Provider: "discord" }, {})).toBe("< > hello");
});
it("respects LINE prefixed group keys in reply-stage requireMention resolution", async () => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "line", plugin: createChannelTestPluginBase({ id: "line" }), source: "test" },
    ]),
  );
  const cfg: OpenClawConfig = {
    channels: { line: { groups: { r123: { requireMention: false } } } },
  };
  const { group } = prepareReplyConversation({
    ctx: { Provider: "line", From: "line:room:r123" },
    groupResolution: { key: "line:group:r123", channel: "line", id: "r123", chatType: "group" },
  });
  await expect(resolveGroupRequireMention({ cfg, group })).resolves.toBe(false);
});

import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveGroupRequireMention } from "./reply/groups.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { claimInboundDedupe, resetInboundDedupe } from "./reply/inbound-dedupe.js";
import { buildMentionRegexes, matchesMentionPatterns, stripMentions } from "./reply/mentions.js";
import { prepareReplyConversation } from "./reply/prompt-session-context.js";
import { initSessionState } from "./reply/session.js";
import { applyTemplate, type MsgContext, type TemplateContext } from "./templating.js";

type TestChannelGroupContext = {
  cfg: OpenClawConfig;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
};

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
  buildMentionRegexes(cfg, undefined, { provider, conversationId });
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

function installGroupRequireMentionTestPlugins(
  resolveRequireMention?: (params: TestChannelGroupContext) => boolean | undefined,
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord" }),
          groups: { resolveRequireMention },
        },
        source: "test",
      },
      { pluginId: "line", plugin: createChannelTestPluginBase({ id: "line" }), source: "test" },
    ]),
  );
}

describe("applyTemplate", () => {
  it("renders primitive values", () => {
    const ctx = { MessageSid: "sid", IsNewSession: "no" } as TemplateContext;
    const overrides = ctx as Record<string, unknown>;
    overrides.MessageSid = 42;
    overrides.IsNewSession = true;

    expect(applyTemplate("sid={{MessageSid}} new={{IsNewSession}}", ctx)).toBe("sid=42 new=true");
  });

  it("renders arrays of primitives", () => {
    const ctx = { MediaPaths: ["a"] } as TemplateContext;
    (ctx as Record<string, unknown>).MediaPaths = ["a", 2, true, null, { ok: false }];

    expect(applyTemplate("paths={{MediaPaths}}", ctx)).toBe("paths=a,2,true");
  });

  it("drops object values", () => {
    const ctx: TemplateContext = { CommandArgs: { raw: "go" } };

    expect(applyTemplate("args={{CommandArgs}}", ctx)).toBe("args=");
  });

  it("never renders channel-owned conversation image references", () => {
    const ctx = {
      ConversationAvatar: "/private/media/inbound/avatar.png",
    } as unknown as TemplateContext;

    expect(applyTemplate("avatar={{ConversationAvatar}}", ctx)).toBe("avatar=");
  });
});

describe("finalizeInboundContext", () => {
  it("fills BodyForAgent/BodyForCommands and normalizes newlines", () => {
    const out = finalizeInboundContext({
      Body: "a\r\nb\rc",
      RawBody: "raw\r\nline",
      ChatType: "channel",
      From: "whatsapp:group:123@g.us",
      GroupSubject: "Test",
    });
    expect(out).toMatchObject({
      Body: "a\nb\nc",
      RawBody: "raw\nline",
      BodyForAgent: "raw\nline",
      BodyForCommands: "raw\nline",
      CommandAuthorized: false,
      CommandTurn: normalTurn,
      ChatType: "channel",
    });
    expect(out.ConversationLabel).toContain("Test");
  });

  it("normalizes structured command turn context and legacy command fields together", () => {
    const out = finalizeInboundContext({
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
    const out = finalizeInboundContext({ ...authorizedNormalTurn, Body, CommandSource });
    expect(CommandSource ? out : finalizeInboundContext(out)).toMatchObject(authorizedNormalTurn);
  });

  it("normalizes trusted group system prompt newlines without rewriting prompt markers", () => {
    const out = finalizeInboundContext({
      Body: "hello",
      GroupSystemPrompt: "[Assistant] room guidance\r\nSystem: owner instruction",
    });

    expect(out.GroupSystemPrompt).toBe("[Assistant] room guidance\nSystem: owner instruction");
  });

  it("preserves literal backslash-n in Windows paths", () => {
    const windowsPath = "C:\\Work\\nxxx\\README.md";
    const out = finalizeInboundContext({
      Body: windowsPath,
      RawBody: windowsPath,
      ChatType: "direct",
      From: "web:user",
    });
    expect(out).toMatchObject({
      Body: windowsPath,
      BodyForAgent: windowsPath,
      BodyForCommands: windowsPath,
    });
  });

  it("can force BodyForCommands to follow updated CommandBody", () => {
    const ctx: MsgContext = {
      Body: "base",
      BodyForCommands: "<media:audio>",
      CommandBody: "say hi",
      From: "signal:+15550001111",
      ChatType: "direct",
    };

    finalizeInboundContext(ctx, { forceBodyForCommands: true });
    expect(ctx.BodyForCommands).toBe("say hi");
  });
});

describe("inbound dedupe", () => {
  beforeEach(() => resetInboundDedupe());
  it("does not dedupe when the peer changes", () => {
    const base = inboundMessage();
    commitInboundForTest({ ...base, OriginatingTo: "whatsapp:+1000" });
    expect(claimInboundDedupe({ ...base, OriginatingTo: "whatsapp:+2000" }).status).toBe("claimed");
  });

  it("does not dedupe across agent ids", () => {
    const base = inboundMessage();
    commitInboundForTest({ ...base, SessionKey: "agent:alpha:main" });
    expect(
      claimInboundDedupe({ ...base, SessionKey: "agent:bravo:whatsapp:direct:+1555" }).status,
    ).toBe("claimed");
    expect(claimInboundDedupe({ ...base, SessionKey: "agent:alpha:main" })).toEqual({
      status: "duplicate",
    });
  });

  it("dedupes when the same agent sees the same inbound message under different session keys", () => {
    const base = inboundMessage({
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:7463849194",
    });
    commitInboundForTest({ ...base, SessionKey: "agent:main:main" });
    expect(
      claimInboundDedupe({ ...base, SessionKey: "agent:main:telegram:direct:7463849194" }),
    ).toEqual({ status: "duplicate" });
  });
});

const senderMetaTempDirs = useSessionStoreTempDirs(afterAll, "openclaw-sender-meta-");

describe("initSessionState BodyStripped", () => {
  it.each([
    {
      ChatType: "group",
      Body: "[WhatsApp 123@g.us] ping",
      SenderId: "222@s.whatsapp.net",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    },
    { ChatType: "direct", Body: "[WhatsApp +1] ping", SessionKey: "agent:main:whatsapp:dm:+222" },
  ])("prefers BodyForAgent over Body for $ChatType chats", async (context) => {
    const result = await initSessionState({
      ctx: finalizeInboundContext({
        ...context,
        BodyForAgent: "ping",
        SenderName: "Bob",
        SenderE164: "+222",
      }),
      cfg: { session: { store: path.join(senderMetaTempDirs.make(), "sessions.json") } },
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("ping");
  });
});

describe("mention helpers", () => {
  it("builds regexes and skips invalid or unsafe patterns", () => {
    const regexes = buildMentionRegexes(mentionConfig([botMention, "(invalid", "(a+)+$"]));
    expect(regexes).toHaveLength(1);
    expect(regexes[0]?.test("openclaw")).toBe(true);
  });

  it("matches patterns case-insensitively", () => {
    const regexes = buildMentionRegexes(mentionConfig([botMention]));
    expect(matchesMentionPatterns("OPEN\u200bCLAW: hi", regexes)).toBe(true);
  });

  it("lets catch-all mention patterns match empty text", () => {
    const catchAllRegexes = buildMentionRegexes(mentionConfig([".*"]));
    const specificRegexes = buildMentionRegexes(mentionConfig([botMention]));

    expect(matchesMentionPatterns("", catchAllRegexes)).toBe(true);
    expect(matchesMentionPatterns("", specificRegexes)).toBe(false);
  });

  it("uses per-agent mention patterns when configured", () => {
    const regexes = buildMentionRegexes(
      {
        ...mentionConfig(["\\bglobal\\b"]),
        agents: { entries: { work: { groupChat: { mentionPatterns: ["\\bworkbot\\b"] } } } },
      },
      "work",
    );
    expect(matchesMentionPatterns("workbot: hi", regexes)).toBe(true);
    expect(matchesMentionPatterns("global: hi", regexes)).toBe(false);
  });

  it("scopes configured mention patterns by provider conversation policy", () => {
    const cfg = policyConfig({
      slack: { mentionPatterns: { mode: "deny", allowIn: ["C123"] } },
    });
    expect(matchesMentionPatterns("openclaw: hi", policyMentions(cfg, "slack", "C123"))).toBe(true);
    expect(matchesMentionPatterns("openclaw: hi", policyMentions(cfg, "slack", "C999"))).toBe(
      false,
    );
  });

  it("lets provider deny lists override globally allowed mention patterns", () => {
    const cfg = policyConfig({ telegram: { mentionPatterns: { denyIn: ["-100:topic:7"] } } });
    expect(policyMentions(cfg, "telegram", "-100:topic:7")).toEqual([]);
    expect(
      matchesMentionPatterns("openclaw", policyMentions(cfg, "telegram", "-100:topic:8")),
    ).toBe(true);
  });

  it("strips safe mention patterns and ignores unsafe ones", () => {
    const stripped = stripMentions(
      "openclaw " + "a".repeat(28) + "!",
      {},
      mentionConfig([botMention, "(a+)+$"]),
    );
    expect(stripped).toBe(`${"a".repeat(28)}!`);
  });

  it("strips provider mention regexes without config compilation", () => {
    const stripped = stripMentions("<@12345> hello", { Provider: "discord" }, {});
    expect(stripped).toBe("< > hello");
  });
});

describe("resolveGroupRequireMention", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    installGroupRequireMentionTestPlugins();
  });

  it("passes prepared group facts to the plugin and honors an explicit false policy", async () => {
    const resolveRequireMention = vi.fn((_params: TestChannelGroupContext) => false);
    installGroupRequireMentionTestPlugins(resolveRequireMention);
    const cfg: OpenClawConfig = {};
    const { group } = prepareReplyConversation({
      ctx: {
        Provider: "discord",
        From: "discord:group:123",
        GroupChannel: "#general",
        GroupSpace: "guild-145",
        AccountId: "work",
      },
      groupResolution: {
        key: "discord:group:123",
        channel: "discord",
        id: "123",
        chatType: "group",
      },
    });

    await expect(resolveGroupRequireMention({ cfg, group })).resolves.toBe(false);
    expect(resolveRequireMention).toHaveBeenCalledExactlyOnceWith({
      cfg,
      groupId: "123",
      groupChannel: "#general",
      groupSpace: "guild-145",
      accountId: "work",
    });
  });

  it("respects LINE prefixed group keys in reply-stage requireMention resolution", async () => {
    const cfg: OpenClawConfig = {
      channels: { line: { groups: { r123: { requireMention: false } } } },
    };
    const { group } = prepareReplyConversation({
      ctx: { Provider: "line", From: "line:room:r123" },
      groupResolution: { key: "line:group:r123", channel: "line", id: "r123", chatType: "group" },
    });
    await expect(resolveGroupRequireMention({ cfg, group })).resolves.toBe(false);
  });
});

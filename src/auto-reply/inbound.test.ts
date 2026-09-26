/** Tests inbound auto-reply handling across channel message contexts. */
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GroupKeyResolution } from "../config/sessions.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveGroupRequireMention } from "./reply/groups.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { claimInboundDedupe, resetInboundDedupe } from "./reply/inbound-dedupe.js";
import { normalizeInboundTextNewlines } from "./reply/inbound-text.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  normalizeMentionText,
  stripMentions,
} from "./reply/mentions.js";
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
      {
        pluginId: "line",
        plugin: createChannelTestPluginBase({ id: "line" }),
        source: "test",
      },
      {
        pluginId: "imessage",
        plugin: createChannelTestPluginBase({ id: "imessage" }),
        source: "test",
      },
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

  it("renders missing placeholders as empty", () => {
    const ctx: TemplateContext = {};

    expect(applyTemplate("missing={{Missing}}", ctx)).toBe("missing=");
  });

  it("never renders channel-owned conversation image references", () => {
    const ctx = {
      ConversationAvatar: "/private/media/inbound/avatar.png",
    } as unknown as TemplateContext;

    expect(applyTemplate("avatar={{ConversationAvatar}}", ctx)).toBe("avatar=");
  });
});

describe("normalizeInboundTextNewlines", () => {
  it("normalizes CRLF/CR to LF", () => {
    expect(normalizeInboundTextNewlines("a\r\nb")).toBe("a\nb");
    expect(normalizeInboundTextNewlines("a\rb")).toBe("a\nb");
  });
});

describe("finalizeInboundContext", () => {
  it("fills BodyForAgent/BodyForCommands and normalizes newlines", () => {
    const ctx: MsgContext = {
      // Use actual CRLF for newline normalization test, not literal \n sequences
      Body: "a\r\nb\r\nc",
      RawBody: "raw\r\nline",
      ChatType: "channel",
      From: "whatsapp:group:123@g.us",
      GroupSubject: "Test",
    };

    const out = finalizeInboundContext(ctx);
    expect(out.Body).toBe("a\nb\nc");
    expect(out.RawBody).toBe("raw\nline");
    // Prefer clean text over legacy envelope-shaped Body when RawBody is present.
    expect(out.BodyForAgent).toBe("raw\nline");
    expect(out.BodyForCommands).toBe("raw\nline");
    expect(out.CommandAuthorized).toBe(false);
    expect(out.CommandTurn).toMatchObject({
      kind: "normal",
      source: "message",
      authorized: false,
    });
    expect(out.ChatType).toBe("channel");
    expect(out.ConversationLabel).toContain("Test");
  });

  it("normalizes structured command turn context and legacy command fields together", () => {
    const out = finalizeInboundContext({
      Body: "/status",
      CommandBody: "/status",
      CommandAuthorized: false,
      CommandTurn: {
        kind: "text-slash" as const,
        source: "text" as const,
        authorized: true,
      },
    });

    expect(out.CommandTurn).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "status",
      body: "/status",
    });
    expect(out.CommandSource).toBe("text");
    expect(out.CommandAuthorized).toBe(true);
  });

  it("clears stale legacy command source without dropping normal-turn command auth", () => {
    const out = finalizeInboundContext({
      Body: "hello",
      CommandSource: "native",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "normal" as const,
        source: "message" as const,
        authorized: false,
      },
    });

    expect(out.CommandTurn).toMatchObject({
      kind: "normal",
      source: "message",
      authorized: false,
    });
    expect(out.CommandSource).toBeUndefined();
    expect(out.CommandAuthorized).toBe(true);
  });

  it("keeps normal command authorization stable across repeated finalization", () => {
    const out = finalizeInboundContext({
      Body: "please inspect `/tmp/foo`",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "normal" as const,
        source: "message" as const,
        authorized: false,
      },
    });

    const refinalized = finalizeInboundContext(out);

    expect(refinalized.CommandTurn).toMatchObject({
      kind: "normal",
      source: "message",
      authorized: false,
    });
    expect(refinalized.CommandSource).toBeUndefined();
    expect(refinalized.CommandAuthorized).toBe(true);
  });

  it("normalizes trusted group system prompt newlines without rewriting prompt markers", () => {
    const out = finalizeInboundContext({
      Body: "hello",
      GroupSystemPrompt: "[Assistant] room guidance\r\nSystem: owner instruction",
    });

    expect(out.GroupSystemPrompt).toBe("[Assistant] room guidance\nSystem: owner instruction");
  });

  it("preserves literal backslash-n in Windows paths", () => {
    const ctx: MsgContext = {
      Body: "C:\\Work\\nxxx\\README.md",
      RawBody: "C:\\Work\\nxxx\\README.md",
      ChatType: "direct",
      From: "web:user",
    };

    const out = finalizeInboundContext(ctx);
    expect(out.Body).toBe("C:\\Work\\nxxx\\README.md");
    expect(out.BodyForAgent).toBe("C:\\Work\\nxxx\\README.md");
    expect(out.BodyForCommands).toBe("C:\\Work\\nxxx\\README.md");
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

  it("fills a generic content type only when media exists", () => {
    const withMedia: MsgContext = {
      Body: "hi",
      media: [{ path: "/tmp/file.bin" }],
    };
    const outWithMedia = finalizeInboundContext(withMedia);
    expect(outWithMedia.media).toEqual([
      expect.objectContaining({ path: "/tmp/file.bin", contentType: "application/octet-stream" }),
    ]);

    const withoutMedia: MsgContext = { Body: "hi" };
    const outWithoutMedia = finalizeInboundContext(withoutMedia);
    expect(outWithoutMedia.media).toBeUndefined();
  });
});

describe("inbound dedupe", () => {
  it("skips duplicates with the same key", () => {
    resetInboundDedupe();
    const ctx: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+1555",
      MessageSid: "msg-1",
    };
    commitInboundForTest(ctx);
    expect(claimInboundDedupe(ctx)).toEqual({ status: "duplicate" });
  });

  it("does not dedupe when the peer changes", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      MessageSid: "msg-1",
    };
    commitInboundForTest({ ...base, OriginatingTo: "whatsapp:+1000" });
    expect(claimInboundDedupe({ ...base, OriginatingTo: "whatsapp:+2000" }).status).toBe("claimed");
  });

  it("does not dedupe across agent ids", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+1555",
      MessageSid: "msg-1",
    };
    commitInboundForTest({ ...base, SessionKey: "agent:alpha:main" });
    expect(
      claimInboundDedupe({ ...base, SessionKey: "agent:bravo:whatsapp:direct:+1555" }).status,
    ).toBe("claimed");
    expect(claimInboundDedupe({ ...base, SessionKey: "agent:alpha:main" })).toEqual({
      status: "duplicate",
    });
  });

  it("dedupes when the same agent sees the same inbound message under different session keys", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:7463849194",
      MessageSid: "msg-1",
    };
    commitInboundForTest({ ...base, SessionKey: "agent:main:main" });
    expect(
      claimInboundDedupe({ ...base, SessionKey: "agent:main:telegram:direct:7463849194" }),
    ).toEqual({ status: "duplicate" });
  });
});

const senderMetaTempDirs = createSuiteTempRootTracker({
  prefix: "openclaw-sender-meta-",
});

describe("initSessionState BodyStripped", () => {
  beforeAll(async () => {
    await senderMetaTempDirs.setup();
  });

  afterAll(async () => {
    await senderMetaTempDirs.cleanup();
  });

  it("prefers BodyForAgent over Body for group chats", async () => {
    const root = await senderMetaTempDirs.make("group");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: finalizeInboundContext({
        Body: "[WhatsApp 123@g.us] ping",
        BodyForAgent: "ping",
        ChatType: "group",
        SenderName: "Bob",
        SenderE164: "+222",
        SenderId: "222@s.whatsapp.net",
        SessionKey: "agent:main:whatsapp:group:123@g.us",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("ping");
  });

  it("prefers BodyForAgent over Body for direct chats", async () => {
    const root = await senderMetaTempDirs.make("direct");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: finalizeInboundContext({
        Body: "[WhatsApp +1] ping",
        BodyForAgent: "ping",
        ChatType: "direct",
        SenderName: "Bob",
        SenderE164: "+222",
        SessionKey: "agent:main:whatsapp:dm:+222",
      }),
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("ping");
  });
});

describe("mention helpers", () => {
  it("builds regexes and skips invalid or unsafe patterns", () => {
    const regexes = buildMentionRegexes({
      messages: {
        groupChat: { mentionPatterns: ["\\bopenclaw\\b", "(invalid", "(a+)+$"] },
      },
    });
    expect(regexes).toHaveLength(1);
    expect(regexes[0]?.test("openclaw")).toBe(true);
  });

  it("normalizes zero-width characters", () => {
    expect(normalizeMentionText("open\u200bclaw")).toBe("openclaw");
  });

  it("matches patterns case-insensitively", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
    });
    expect(matchesMentionPatterns("OPENCLAW: hi", regexes)).toBe(true);
  });

  it("lets catch-all mention patterns match empty text", () => {
    const catchAllRegexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: [".*"] } },
    });
    const specificRegexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
    });

    expect(matchesMentionPatterns("", catchAllRegexes)).toBe(true);
    expect(matchesMentionPatterns("", specificRegexes)).toBe(false);
  });

  it("uses per-agent mention patterns when configured", () => {
    const regexes = buildMentionRegexes(
      {
        messages: {
          groupChat: { mentionPatterns: ["\\bglobal\\b"] },
        },
        agents: {
          list: [
            {
              id: "work",
              groupChat: { mentionPatterns: ["\\bworkbot\\b"] },
            },
          ],
        },
      },
      "work",
    );
    expect(matchesMentionPatterns("workbot: hi", regexes)).toBe(true);
    expect(matchesMentionPatterns("global: hi", regexes)).toBe(false);
  });

  it("scopes configured mention patterns by provider conversation policy", () => {
    const cfg = {
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
      channels: {
        slack: {
          mentionPatterns: {
            mode: "deny",
            allowIn: ["C123"],
          },
        },
      },
    } satisfies OpenClawConfig;

    const allowed = buildMentionRegexes(cfg, undefined, {
      provider: "slack",
      conversationId: "C123",
    });
    const denied = buildMentionRegexes(cfg, undefined, {
      provider: "slack",
      conversationId: "C999",
    });

    expect(matchesMentionPatterns("openclaw: hi", allowed)).toBe(true);
    expect(matchesMentionPatterns("openclaw: hi", denied)).toBe(false);
  });

  it("lets provider deny lists override globally allowed mention patterns", () => {
    const cfg = {
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
      channels: {
        telegram: {
          mentionPatterns: {
            denyIn: ["-100:topic:7"],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      buildMentionRegexes(cfg, undefined, {
        provider: "telegram",
        conversationId: "-100:topic:7",
      }),
    ).toEqual([]);
    expect(
      matchesMentionPatterns(
        "openclaw",
        buildMentionRegexes(cfg, undefined, {
          provider: "telegram",
          conversationId: "-100:topic:8",
        }),
      ),
    ).toBe(true);
  });

  it("strips safe mention patterns and ignores unsafe ones", () => {
    const stripped = stripMentions("openclaw " + "a".repeat(28) + "!", {} as MsgContext, {
      messages: {
        groupChat: { mentionPatterns: ["\\bopenclaw\\b", "(a+)+$"] },
      },
    });
    expect(stripped).toBe(`${"a".repeat(28)}!`);
  });

  it("strips provider mention regexes without config compilation", () => {
    const stripped = stripMentions("<@12345> hello", { Provider: "discord" } as MsgContext, {});
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
      channels: {
        line: {
          groups: {
            r123: { requireMention: false },
          },
        },
      },
    };
    const ctx: TemplateContext = {
      Provider: "line",
      From: "line:room:r123",
    };
    const groupResolution: GroupKeyResolution = {
      key: "line:group:r123",
      channel: "line",
      id: "r123",
      chatType: "group",
    };

    const { group } = prepareReplyConversation({ ctx, groupResolution });
    await expect(resolveGroupRequireMention({ cfg, group })).resolves.toBe(false);
  });

  it("preserves plugin-backed channel requireMention resolution", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          groups: {
            "chat:primary": { requireMention: false },
          },
        },
      },
    };
    const ctx: TemplateContext = {
      Provider: "imessage",
      From: "imessage:group:chat:primary",
    };
    const groupResolution: GroupKeyResolution = {
      key: "imessage:group:chat:primary",
      channel: "imessage",
      id: "chat:primary",
      chatType: "group",
    };

    const { group } = prepareReplyConversation({ ctx, groupResolution });
    await expect(resolveGroupRequireMention({ cfg, group })).resolves.toBe(false);
  });
});

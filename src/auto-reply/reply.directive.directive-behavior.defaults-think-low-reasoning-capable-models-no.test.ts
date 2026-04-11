import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  mockEmbeddedTextResult,
  replyText,
  replyTexts,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import {
  loadModelCatalogMock,
  runEmbeddedPiAgentMock,
} from "./reply.directive.directive-behavior.e2e-mocks.js";
import { getReplyFromConfig } from "./reply.js";
import { handleDirectiveOnly } from "./reply/directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./reply/directive-handling.params.js";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";

function makeDefaultModelConfig(home: string) {
  return makeWhatsAppDirectiveConfig(home, {
    model: { primary: "anthropic/claude-opus-4-6" },
    models: {
      "anthropic/claude-opus-4-6": {},
      "openai/gpt-4.1-mini": {},
    },
  });
}

async function runReplyToCurrentCase(home: string, text: string) {
  runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult(text));

  const res = await getReplyFromConfig(
    {
      Body: "ping",
      From: "+1004",
      To: "+2000",
      MessageSid: "msg-123",
    },
    {},
    makeWhatsAppDirectiveConfig(home, { model: "anthropic/claude-opus-4-6" }),
  );

  return Array.isArray(res) ? res[0] : res;
}

const emptyAliasIndex: ModelAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};

async function expectThinkStatus(params: { expectedLevel: "low" | "off" }): Promise<void> {
  const sessionKey = "agent:main:whatsapp:+1222";
  const sessionEntry: SessionEntry = {
    sessionId: "think-status",
    updatedAt: Date.now(),
  };
  const res = await handleDirectiveOnly({
    cfg: {
      commands: { text: true },
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          workspace: "/tmp/openclaw",
        },
      },
    } as OpenClawConfig,
    directives: parseInlineDirectives("/think"),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: emptyAliasIndex,
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    currentThinkLevel: params.expectedLevel,
  } satisfies HandleDirectiveOnlyParams);

  const text = res?.text;
  expect(text).toContain(`Current thinking level: ${params.expectedLevel}`);
  expect(text).toContain("Options: off, minimal, low, medium, high, adaptive.");
}

async function runModelDirective(body: string): Promise<{
  text?: string;
  sessionEntry: SessionEntry;
}> {
  const sessionKey = "agent:main:whatsapp:+1222";
  const sessionEntry: SessionEntry = {
    sessionId: "model-directive",
    updatedAt: Date.now(),
  };
  const res = await handleDirectiveOnly({
    cfg: {
      commands: { text: true },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          workspace: "/tmp/openclaw",
          models: {
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-4.1-mini": {},
          },
        },
      },
    } as OpenClawConfig,
    directives: parseInlineDirectives(body),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: emptyAliasIndex,
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4.1-mini"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
  } satisfies HandleDirectiveOnlyParams);
  return { text: res?.text, sessionEntry };
}

function mockReasoningCapableCatalog() {
  loadModelCatalogMock.mockResolvedValueOnce([
    {
      id: "claude-opus-4-6",
      name: "Opus 4.5",
      provider: "anthropic",
      reasoning: true,
    },
  ]);
}

async function runReasoningDefaultCase(params: {
  home: string;
  expectedThinkLevel: "low" | "off";
  expectedReasoningLevel: "off" | "on";
  thinkingDefault?: "off" | "low" | "medium" | "high";
}) {
  runEmbeddedPiAgentMock.mockClear();
  mockEmbeddedTextResult("done");
  mockReasoningCapableCatalog();

  await getReplyFromConfig(
    {
      Body: "hello",
      From: "+1004",
      To: "+2000",
    },
    {},
    makeWhatsAppDirectiveConfig(params.home, {
      model: { primary: "anthropic/claude-opus-4-6" },
      ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
    }),
  );

  expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
  const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
  expect(call?.thinkLevel).toBe(params.expectedThinkLevel);
  expect(call?.reasoningLevel).toBe(params.expectedReasoningLevel);
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("covers /think status and reasoning defaults for reasoning and non-reasoning models", async () => {
    await withTempHome(async (home) => {
      await expectThinkStatus({ expectedLevel: "low" });
      await expectThinkStatus({ expectedLevel: "off" });
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();

      runEmbeddedPiAgentMock.mockClear();

      for (const scenario of [
        {
          expectedThinkLevel: "low" as const,
          expectedReasoningLevel: "off" as const,
        },
        {
          expectedThinkLevel: "off" as const,
          expectedReasoningLevel: "on" as const,
          thinkingDefault: "off" as const,
        },
      ]) {
        await runReasoningDefaultCase({
          home,
          ...scenario,
        });
      }
    });
  });
  it("sets model override on /model directive", async () => {
    const result = await runModelDirective("/model openai/gpt-4.1-mini");
    expect(result.text).toContain("Model set to openai/gpt-4.1-mini.");
    expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
    expect(result.sessionEntry.providerOverride).toBe("openai");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("ignores inline /model and /think directives while still running agent content", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");

      const inlineModelRes = await getReplyFromConfig(
        {
          Body: "please sync /model openai/gpt-4.1-mini now",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeDefaultModelConfig(home),
      );

      const texts = replyTexts(inlineModelRes);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-6");
      runEmbeddedPiAgentMock.mockClear();

      mockEmbeddedTextResult("done");
      const inlineThinkRes = await getReplyFromConfig(
        {
          Body: "please sync /think:high now",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-6" } }),
      );

      expect(replyTexts(inlineThinkRes)).toContain("done");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    });
  });
  it("persists /reasoning off on discord even when model defaults reasoning on", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);
      mockEmbeddedTextResult("done");
      loadModelCatalogMock.mockResolvedValue([
        {
          id: "x-ai/grok-4.1-fast",
          name: "Grok 4.1 Fast",
          provider: "openrouter",
          reasoning: true,
        },
      ]);

      const config = makeWhatsAppDirectiveConfig(
        home,
        {
          model: "openrouter/x-ai/grok-4.1-fast",
        },
        {
          channels: {
            discord: { allowFrom: ["*"] },
          },
          session: { store: storePath },
        },
      );

      const offRes = await getReplyFromConfig(
        {
          Body: "/reasoning off",
          From: "discord:user:1004",
          To: "channel:general",
          Provider: "discord",
          Surface: "discord",
          CommandSource: "text",
          CommandAuthorized: true,
        },
        {},
        config,
      );
      expect(replyText(offRes)).toContain("Reasoning visibility disabled.");

      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.reasoningLevel).toBe("off");

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "discord:user:1004",
          To: "channel:general",
          Provider: "discord",
          Surface: "discord",
          CommandSource: "text",
          CommandAuthorized: true,
        },
        {},
        config,
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.reasoningLevel).toBe("off");
    });
  });
  it("handles reply_to_current tags and explicit reply_to precedence", async () => {
    await withTempHome(async (home) => {
      for (const replyTag of ["[[reply_to_current]]", "[[ reply_to_current ]]"]) {
        const payload = await runReplyToCurrentCase(home, `hello ${replyTag}`);
        expect(payload?.text).toBe("hello");
        expect(payload?.replyToId).toBe("msg-123");
      }

      runEmbeddedPiAgentMock.mockResolvedValue(
        makeEmbeddedTextResult("hi [[reply_to_current]] [[reply_to:abc-456]]"),
      );

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-6" } }),
      );

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toBe("hi");
      expect(payload?.replyToId).toBe("abc-456");
    });
  });
});

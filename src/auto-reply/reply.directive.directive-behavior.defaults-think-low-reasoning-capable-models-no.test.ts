import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  loadModelCatalog,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  mockEmbeddedTextResult,
  replyText,
  replyTexts,
  runEmbeddedPiAgent,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runModelDirectiveText } from "./reply.directive.directive-behavior.model-directive-test-utils.js";
import { getReplyFromConfig } from "./reply.js";

function makeDefaultModelConfig(home: string) {
  return makeWhatsAppDirectiveConfig(home, {
    model: { primary: "anthropic/claude-opus-4-5" },
    models: {
      "anthropic/claude-opus-4-5": {},
      "openai/gpt-4.1-mini": {},
    },
  });
}

async function runReplyToCurrentCase(home: string, text: string) {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(makeEmbeddedTextResult(text));

  const res = await getReplyFromConfig(
    {
      Body: "ping",
      From: "+1004",
      To: "+2000",
      MessageSid: "msg-123",
    },
    {},
    makeWhatsAppDirectiveConfig(home, { model: "anthropic/claude-opus-4-5" }),
  );

  return Array.isArray(res) ? res[0] : res;
}

async function expectThinkStatusForReasoningModel(params: {
  reasoning: boolean;
  expectedLevel: "low" | "off";
}): Promise<void> {
  await withTempHome(async (home) => {
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([
      {
        id: "claude-opus-4-5",
        name: "Opus 4.5",
        provider: "anthropic",
        reasoning: params.reasoning,
      },
    ]);

    const res = await getReplyFromConfig(
      { Body: "/think", From: "+1222", To: "+1222", CommandAuthorized: true },
      {},
      makeWhatsAppDirectiveConfig(home, { model: "anthropic/claude-opus-4-5" }),
    );

    const text = replyText(res);
    expect(text).toContain(`Current thinking level: ${params.expectedLevel}`);
    expect(text).toContain("Options: off, minimal, low, medium, high.");
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });
}

function mockReasoningCapableCatalog() {
  vi.mocked(loadModelCatalog).mockResolvedValueOnce([
    {
      id: "claude-opus-4-5",
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
      model: { primary: "anthropic/claude-opus-4-5" },
      ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
    }),
  );

  expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
  const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
  expect(call?.thinkLevel).toBe(params.expectedThinkLevel);
  expect(call?.reasoningLevel).toBe(params.expectedReasoningLevel);
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("defaults /think to low for reasoning-capable models when no default set", async () => {
    await expectThinkStatusForReasoningModel({
      reasoning: true,
      expectedLevel: "low",
    });
  });
  it("shows off when /think has no argument and model lacks reasoning", async () => {
    await expectThinkStatusForReasoningModel({
      reasoning: false,
      expectedLevel: "off",
    });
  });
  it("aliases /model list to /models", async () => {
    await withTempHome(async (home) => {
      const text = await runModelDirectiveText(home, "/model list");
      expect(text).toContain("Providers:");
      expect(text).toContain("- anthropic");
      expect(text).toContain("- openai");
      expect(text).toContain("Use: /models <provider>");
      expect(text).toContain("Switch: /model <provider/model>");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("shows current model when catalog is unavailable", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([]);
      const text = await runModelDirectiveText(home, "/model");
      expect(text).toContain("Current: anthropic/claude-opus-4-5");
      expect(text).toContain("Switch: /model <provider/model>");
      expect(text).toContain("Browse: /models (providers) or /models <provider> (models)");
      expect(text).toContain("More: /model status");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("lists allowlisted models on /model status", async () => {
    await withTempHome(async (home) => {
      const text = await runModelDirectiveText(home, "/model status", {
        includeSessionStore: false,
      });
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(text).toContain("openai/gpt-4.1-mini");
      expect(text).not.toContain("claude-sonnet-4-1");
      expect(text).toContain("auth:");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("includes catalog providers when no allowlist is set", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValue([
        { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "grok-4", name: "Grok 4", provider: "xai" },
      ]);
      const text = await runModelDirectiveText(home, "/model list", {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-5",
            fallbacks: ["openai/gpt-4.1-mini"],
          },
          imageModel: { primary: "minimax/MiniMax-M2.1" },
          models: undefined,
        },
      });
      expect(text).toContain("Providers:");
      expect(text).toContain("- anthropic");
      expect(text).toContain("- openai");
      expect(text).toContain("- xai");
      expect(text).toContain("Use: /models <provider>");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("lists config-only providers when catalog is present", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          provider: "anthropic",
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
        },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
      ]);
      const text = await runModelDirectiveText(home, "/models minimax", {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            "openai/gpt-4.1-mini": {},
            "minimax/MiniMax-M2.1": { alias: "minimax" },
          },
        },
        extra: {
          models: {
            mode: "merge",
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                models: [{ id: "MiniMax-M2.1", name: "MiniMax M2.1" }],
              },
            },
          },
        },
      });
      expect(text).toContain("Models (minimax");
      expect(text).toContain("minimax/MiniMax-M2.1");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("does not repeat missing auth labels on /model list", async () => {
    await withTempHome(async (home) => {
      const text = await runModelDirectiveText(home, "/model list", {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
          },
        },
      });
      expect(text).toContain("Providers:");
      expect(text).not.toContain("missing (missing)");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("sets model override on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      await getReplyFromConfig(
        { Body: "/model openai/gpt-4.1-mini", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "anthropic/claude-opus-4-5": {},
              "openai/gpt-4.1-mini": {},
            },
          },
          { session: { store: storePath } },
        ),
      );

      assertModelSelection(storePath, {
        model: "gpt-4.1-mini",
        provider: "openai",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("ignores inline /model and uses the default model", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");

      const res = await getReplyFromConfig(
        {
          Body: "please sync /model openai/gpt-4.1-mini now",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeDefaultModelConfig(home),
      );

      const texts = replyTexts(res);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-5");
    });
  });
  it("defaults thinking to low for reasoning-capable models without auto-enabling reasoning", async () => {
    await withTempHome(async (home) => {
      await runReasoningDefaultCase({
        home,
        expectedThinkLevel: "low",
        expectedReasoningLevel: "off",
      });
    });
  });
  it("keeps auto-reasoning enabled when thinking is explicitly off", async () => {
    await withTempHome(async (home) => {
      await runReasoningDefaultCase({
        home,
        expectedThinkLevel: "off",
        expectedReasoningLevel: "on",
        thinkingDefault: "off",
      });
    });
  });
  it("passes elevated defaults when sender is approved", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1004",
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: { primary: "anthropic/claude-opus-4-5" } },
          {
            tools: {
              elevated: {
                allowFrom: { whatsapp: ["+1004"] },
              },
            },
          },
        ),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.bashElevated).toEqual({
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      });
    });
  });
  it("persists /reasoning off on discord even when model defaults reasoning on", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);
      mockEmbeddedTextResult("done");
      vi.mocked(loadModelCatalog).mockResolvedValue([
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

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.reasoningLevel).toBe("off");
    });
  });
  for (const replyTag of ["[[reply_to_current]]", "[[ reply_to_current ]]"]) {
    it(`strips ${replyTag} and maps reply_to_current to MessageSid`, async () => {
      await withTempHome(async (home) => {
        const payload = await runReplyToCurrentCase(home, `hello ${replyTag}`);
        expect(payload?.text).toBe("hello");
        expect(payload?.replyToId).toBe("msg-123");
      });
    });
  }
  it("prefers explicit reply_to id over reply_to_current", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue(
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
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-5" } }),
      );

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toBe("hi");
      expect(payload?.replyToId).toBe("abc-456");
    });
  });
  it("applies inline think and still runs agent content", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");

      const res = await getReplyFromConfig(
        {
          Body: "please sync /think:high now",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-5" } }),
      );

      const texts = replyTexts(res);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
});

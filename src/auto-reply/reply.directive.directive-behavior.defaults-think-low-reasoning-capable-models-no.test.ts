import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
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
import { getReplyFromConfig } from "./reply.js";

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

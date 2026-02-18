import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import {
  installDirectiveBehaviorE2EHooks,
  loadModelCatalog,
  makeWhatsAppDirectiveConfig,
  mockEmbeddedTextResult,
  replyTexts,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
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

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

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
  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedTextResult("done");
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          To: "+2000",
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "anthropic/claude-opus-4-5" } }),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.thinkLevel).toBe("low");
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
});

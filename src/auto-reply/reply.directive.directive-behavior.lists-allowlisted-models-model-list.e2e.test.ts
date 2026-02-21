import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  loadModelCatalog,
  makeWhatsAppDirectiveConfig,
  replyText,
  runEmbeddedPiAgent,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

async function runModelDirective(
  home: string,
  body: string,
  options: {
    defaults?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string | undefined> {
  const res = await getReplyFromConfig(
    { Body: body, From: "+1222", To: "+1222", CommandAuthorized: true },
    {},
    makeWhatsAppDirectiveConfig(
      home,
      {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
        },
        ...options.defaults,
      },
      { session: { store: sessionStorePath(home) }, ...options.extra },
    ),
  );
  return replyText(res);
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("aliases /model list to /models", async () => {
    await withTempHome(async (home) => {
      const text = await runModelDirective(home, "/model list");
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
      const text = await runModelDirective(home, "/model");
      expect(text).toContain("Current: anthropic/claude-opus-4-5");
      expect(text).toContain("Switch: /model <provider/model>");
      expect(text).toContain("Browse: /models (providers) or /models <provider> (models)");
      expect(text).toContain("More: /model status");
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
      const text = await runModelDirective(home, "/model list", {
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
      // Catalog present but missing custom providers: /model should still include
      // allowlisted provider/model keys from config.
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          provider: "anthropic",
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
        },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
      ]);
      const text = await runModelDirective(home, "/models minimax", {
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
      const text = await runModelDirective(home, "/model list", {
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
  it("supports model aliases on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          {
            model: { primary: "openai/gpt-4.1-mini" },
            models: {
              "openai/gpt-4.1-mini": {},
              "anthropic/claude-opus-4-5": { alias: "Opus" },
            },
          },
          { session: { store: storePath } },
        ),
      );

      assertModelSelection(storePath, {
        model: "claude-opus-4-5",
        provider: "anthropic",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect } from "vitest";
import type { SessionEntry } from "./sessions-storage.js";
import type { OpenClawConfig } from "../config/config.js";
import { applySessionPatch } from "./sessions-patch.js";

// Bug #46059: When switching models in control panel, old provider is retained
// causing "model not allowed" error

describe("sessions-patch model switching with provider", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
      },
    },
    models: {
      providers: {
        anthropic: {
          models: [{ id: "claude-sonnet-4-6" }],
        },
        openai: {
          models: [{ id: "gpt-5.2" }],
        },
      },
    },
  } as OpenClawConfig;

  it("should allow switching from anthropic to openai model without provider prefix", () => {
    const store: Record<string, SessionEntry> = {
      test: {
        id: "test",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      } as SessionEntry,
    };

    // User switches to gpt-5.2 without provider prefix
    // This should resolve to openai/gpt-5.2, not anthropic/gpt-5.2
    const result = applySessionPatch({
      store,
      storeKey: "test",
      patch: { model: "gpt-5.2" },
      cfg,
      resolvedDefault: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.providerOverride).toBe("openai");
      expect(result.entry.modelOverride).toBe("gpt-5.2");
    }
  });

  it("should handle model with explicit provider prefix", () => {
    const store: Record<string, SessionEntry> = {
      test: {
        id: "test",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      } as SessionEntry,
    };

    const result = applySessionPatch({
      store,
      storeKey: "test",
      patch: { model: "openai/gpt-5.2" },
      cfg,
      resolvedDefault: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.providerOverride).toBe("openai");
      expect(result.entry.modelOverride).toBe("gpt-5.2");
    }
  });
});

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { validateAndSanitizeSessionEntry, validateSessionStore } from "./store-validation.js";
import type { SessionEntry } from "./types.js";

function createMockConfig(providers: string[]): OpenClawConfig {
  const models: Record<string, { baseUrl?: string }> = {};
  for (const provider of providers) {
    models[provider] = { baseUrl: `https://${provider}.example.com` };
  }
  return {
    models: {
      providers: models,
    },
  } as OpenClawConfig;
}

function createMockSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session",
    updatedAt: Date.now(),
    ...overrides,
  } as SessionEntry;
}

describe("store-validation", () => {
  describe("validateAndSanitizeSessionEntry", () => {
    it("does not modify entry when provider is configured", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const entry = createMockSessionEntry({
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      });

      const modified = validateAndSanitizeSessionEntry(entry, cfg);

      expect(modified).toBe(false);
      expect(entry.providerOverride).toBe("anthropic");
      expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    });

    it("clears providerOverride and modelOverride when provider is not configured", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const entry = createMockSessionEntry({
        providerOverride: "openrouter",
        modelOverride: "claude-sonnet-4-6",
      });

      const modified = validateAndSanitizeSessionEntry(entry, cfg);

      expect(modified).toBe(true);
      expect(entry.providerOverride).toBeUndefined();
      expect(entry.modelOverride).toBeUndefined();
    });

    it("clears modelProvider and model when provider is not configured", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const entry = createMockSessionEntry({
        modelProvider: "openrouter",
        model: "claude-sonnet-4-6",
      });

      const modified = validateAndSanitizeSessionEntry(entry, cfg);

      expect(modified).toBe(true);
      expect(entry.modelProvider).toBeUndefined();
      expect(entry.model).toBeUndefined();
    });

    it("handles empty provider config gracefully", () => {
      const cfg = createMockConfig([]);
      const entry = createMockSessionEntry({
        providerOverride: "openrouter",
        modelOverride: "claude-sonnet-4-6",
      });

      const modified = validateAndSanitizeSessionEntry(entry, cfg);

      expect(modified).toBe(true);
      expect(entry.providerOverride).toBeUndefined();
      expect(entry.modelOverride).toBeUndefined();
    });

    it("does not modify entry when only modelOverride is set without providerOverride", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const entry = createMockSessionEntry({
        modelOverride: "claude-sonnet-4-6",
      });

      const modified = validateAndSanitizeSessionEntry(entry, cfg);

      // Should not modify because we can't determine which provider to check
      expect(modified).toBe(false);
      expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    });
  });

  describe("validateSessionStore", () => {
    it("validates all entries in the store", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const store: Record<string, SessionEntry> = {
        "session-1": createMockSessionEntry({
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
        }),
        "session-2": createMockSessionEntry({
          providerOverride: "openrouter",
          modelOverride: "claude-sonnet-4-6",
        }),
        "session-3": createMockSessionEntry({
          modelProvider: "openrouter",
          model: "gpt-4",
        }),
      };

      const modifiedCount = validateSessionStore(store, cfg);

      expect(modifiedCount).toBe(2);
      expect(store["session-1"].providerOverride).toBe("anthropic"); // unchanged
      expect(store["session-2"].providerOverride).toBeUndefined(); // cleared
      expect(store["session-3"].modelProvider).toBeUndefined(); // cleared
    });

    it("returns 0 when no entries need modification", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const store: Record<string, SessionEntry> = {
        "session-1": createMockSessionEntry({
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
        }),
        "session-2": createMockSessionEntry({
          modelProvider: "openai",
          model: "gpt-4",
        }),
      };

      const modifiedCount = validateSessionStore(store, cfg);

      expect(modifiedCount).toBe(0);
    });

    it("handles empty store gracefully", () => {
      const cfg = createMockConfig(["anthropic", "openai"]);
      const store: Record<string, SessionEntry> = {};

      const modifiedCount = validateSessionStore(store, cfg);

      expect(modifiedCount).toBe(0);
    });
  });
});

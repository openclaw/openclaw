import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

/**
 * Integration tests for model persistence in sessions.patch
 * Verifies that models set via sessions.patch are correctly stored
 * and would be readable by subsequent agent calls.
 *
 * Related to issue #6817: sessions_spawn ignores model parameter
 */
describe("sessions.patch model persistence (#6817)", () => {
  test("persists model override for new subagent session", async () => {
    // Simulate sessions_spawn creating a new subagent session with explicit model
    const store: Record<string, SessionEntry> = {};
    const sessionKey = "agent:research:subagent:test-uuid-123";

    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: sessionKey,
      patch: { model: "openrouter/deepseek/deepseek-chat" },
      loadGatewayModelCatalog: async () => [
        { provider: "openrouter", id: "deepseek/deepseek-chat" },
      ],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    // Verify the model override is stored correctly
    expect(res.entry.providerOverride).toBe("openrouter");
    expect(res.entry.modelOverride).toBe("deepseek/deepseek-chat");

    // Verify the entry is in the store (what agent handler would read)
    expect(store[sessionKey]).toBeDefined();
    expect(store[sessionKey].providerOverride).toBe("openrouter");
    expect(store[sessionKey].modelOverride).toBe("deepseek/deepseek-chat");
  });

  test("persists model override even when session has other fields", async () => {
    // Simulate patching a session that already has some state
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:existing": {
        sessionId: "existing-session",
        updatedAt: Date.now(),
        thinkingLevel: "low",
        label: "Existing-Task",
      } as SessionEntry,
    };

    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:subagent:existing",
      patch: { model: "google/gemini-2.5-flash" },
      loadGatewayModelCatalog: async () => [{ provider: "google", id: "gemini-2.5-flash" }],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    // Model should be set
    expect(res.entry.modelOverride).toBe("gemini-2.5-flash");
    expect(res.entry.providerOverride).toBe("google");

    // Existing fields should be preserved
    expect(res.entry.thinkingLevel).toBe("low");
    expect(res.entry.label).toBe("Existing-Task");
    expect(res.entry.sessionId).toBe("existing-session");
  });

  test("model in catalog without provider prefix resolves correctly", async () => {
    const store: Record<string, SessionEntry> = {};

    const res = await applySessionsPatchToStore({
      cfg: {
        providers: {
          openai: { baseUrl: "https://api.openai.com" },
        },
      } as OpenClawConfig,
      store,
      storeKey: "agent:main:subagent:test",
      patch: { model: "openai/gpt-5.2" },
      loadGatewayModelCatalog: async () => [{ provider: "openai", id: "gpt-5.2" }],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    expect(res.entry.providerOverride).toBe("openai");
    expect(res.entry.modelOverride).toBe("gpt-5.2");
  });

  test("accepts model not in catalog (validates at runtime)", async () => {
    // Note: sessions.patch does NOT validate against catalog - it accepts the model
    // Validation happens later when the agent actually runs
    const store: Record<string, SessionEntry> = {};

    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:subagent:test",
      patch: { model: "unknown/fake-model-xyz" },
      loadGatewayModelCatalog: async () => [
        // Model not in catalog - but sessions.patch still accepts it
        { provider: "openai", id: "gpt-5.2" },
      ],
    });

    // Sessions.patch accepts the model - validation happens at agent runtime
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    expect(res.entry.providerOverride).toBe("unknown");
    expect(res.entry.modelOverride).toBe("fake-model-xyz");
  });

  test("handles model patch without loadGatewayModelCatalog", async () => {
    const store: Record<string, SessionEntry> = {};

    const res = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: "agent:main:subagent:test",
      patch: { model: "openai/gpt-5.2" },
      // No loadGatewayModelCatalog provided
    });

    // Should fail since we can't validate the model
    expect(res.ok).toBe(false);
  });
});

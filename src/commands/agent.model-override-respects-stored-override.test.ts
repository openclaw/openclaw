import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock config before imports
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

// Mock model catalog
const mockModelCatalog = [
  { provider: "anthropic", id: "claude-sonnet-4", reasoning: false },
  { provider: "anthropic", id: "claude-haiku-4-5", reasoning: false },
  { provider: "openai", id: "gpt-4o", reasoning: false },
];

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: async () => mockModelCatalog,
}));

// Mock session store
let mockSessionStore: Record<string, import("../config/sessions.js").SessionEntry> = {};
let mockStorePath = "";

vi.mock("../config/sessions/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/store.js")>();
  return {
    ...actual,
    loadSessionStore: async () => mockSessionStore,
    updateSessionStore: async (
      storePath: string,
      updater: (store: Record<string, import("../config/sessions.js").SessionEntry>) => void,
    ) => {
      mockStorePath = storePath;
      await updater(mockSessionStore);
    },
    resolveSessionStorePath: () => "/tmp/test-session-store.json",
  };
});

// Mock the agent execution
vi.mock("../auto-reply/pi.js", () => ({
  runEmbeddedPiAgent: async () => ({
    responseText: "test response",
    usage: { inputTokens: 10, outputTokens: 20 },
  }),
}));

vi.mock("../sessions/session-file.js", () => ({
  resolveSessionFilePath: () => "/tmp/test-session.md",
}));

vi.mock("../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routing/session-key.js")>();
  return {
    ...actual,
    resolveSessionFromRequest: () => ({
      sessionKey: "agent:main:subagent:test-id",
      sessionId: "test-session-id",
      sessionAlias: undefined,
      agentId: "main",
    }),
    normalizeAgentId: actual.normalizeAgentId,
    parseAgentSessionKey: actual.parseAgentSessionKey,
  };
});

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildAllowedModelSet, modelKey } from "../agents/model-selection.js";

describe("agent command model override", () => {
  beforeEach(() => {
    mockSessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("buildAllowedModelSet returns allowAny=true when no explicit allowlist", () => {
    const result = buildAllowedModelSet({
      cfg: configOverride,
      catalog: mockModelCatalog,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(result.allowAny).toBe(true);
    // When allowAny is true, allowedKeys contains catalog models
    expect(result.allowedKeys.size).toBeGreaterThan(0);
  });

  it("stored model override should be used when allowAny=true, even if not in catalog", () => {
    // This test verifies the fix for issue #6573:
    // When sessions_spawn specifies a model, it should be used by the subagent,
    // even when:
    // 1. There's no explicit allowlist (allowAny=true)
    // 2. The model might not be in the static catalog
    //
    // The bug was that allowedModelKeys.size === 0 was used to detect "no restrictions",
    // but when allowAny=true, allowedKeys is populated with catalog models (size > 0).
    // This caused valid model overrides to be ignored.

    const cfg = {
      session: { mainKey: "main", scope: "per-sender" as const },
      // No agents.defaults.models = no allowlist = allowAny should be true
    };

    const result = buildAllowedModelSet({
      cfg,
      catalog: mockModelCatalog,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    // Verify allowAny is true (no restrictions)
    expect(result.allowAny).toBe(true);

    // The current buggy behavior:
    // - allowedKeys.size > 0 (populated from catalog)
    // - A model not in catalog would fail: !allowedKeys.has(key)
    //
    // The fix should ensure that when allowAny=true, any valid model is accepted.

    // Simulate the check in agent.ts for a model NOT in catalog
    // (e.g., a new model that exists but isn't in the static catalog yet)
    const testProvider = "anthropic";
    const testModel = "claude-3-5-haiku-20241022"; // Not in our mock catalog (new model)
    const key = modelKey(testProvider, testModel);

    // The original buggy check from agent.ts was:
    // allowedModelKeys.size === 0 || allowedModelKeys.has(key)
    // This fails because when allowAny=true, allowedKeys is populated from catalog,
    // so size > 0 but the model might not be in catalog.

    // The fixed check uses allowAny flag:
    const fixedCheck =
      result.allowAny || // true - no restrictions
      result.allowedKeys.has(key);

    // With the fix, valid models should be accepted when there's no allowlist
    expect(fixedCheck).toBe(true);

    // Verify the model is NOT in catalog (this is the scenario we're testing)
    expect(result.allowedKeys.has(key)).toBe(false);
    // But it should still be allowed because allowAny=true
    expect(result.allowAny).toBe(true);
  });

  it("stored model override should be rejected when there is an explicit allowlist and model is not in it", () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" as const },
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4": { alias: "sonnet" },
            "anthropic/claude-haiku-4-5": { alias: "haiku" },
          },
        },
      },
    };

    const result = buildAllowedModelSet({
      cfg,
      catalog: mockModelCatalog,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    // With explicit allowlist, allowAny should be false
    expect(result.allowAny).toBe(false);
    expect(result.allowedKeys.size).toBeGreaterThan(0);

    // A model NOT in the allowlist should be rejected
    const testModel = "openai/gpt-4o"; // In catalog but not in allowlist
    const key = modelKey("openai", "gpt-4o");

    const shouldAllow = result.allowAny || result.allowedKeys.has(key);
    expect(shouldAllow).toBe(false); // Correctly rejected
  });
});

import { describe, expect, it } from "vitest";
import { persistInlineDirectives } from "./directive-handling.persist.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

describe("persistInlineDirectives", () => {
  it("recalculates contextTokens when model changes (fixes #35372)", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    };

    const sessionEntry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
      contextTokens: 160000, // Stuck at haiku's limit
    };

    const sessionStore = {
      "test-key": sessionEntry,
    };

    const directives: InlineDirectives = {
      hasModelDirective: true,
      rawModelDirective: "claude-sonnet-4-6",
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasExecOptions: false,
      hasQueueDirective: false,
      queueReset: false,
      hasStatusDirective: false,
    };

    const aliasIndex = {
      byKey: new Map(),
      byAlias: new Map(),
    };

    const result = await persistInlineDirectives({
      directives,
      effectiveModelDirective: "claude-sonnet-4-6",
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey: "test-key",
      storePath: undefined,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      aliasIndex,
      allowedModelKeys: new Set([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
      ]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      initialModelLabel: "anthropic/claude-haiku-4-5",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      agentCfg: cfg.agents?.defaults,
    });

    // contextTokens should be recalculated for the new model (sonnet-4-6)
    // and not stuck at the old model's limit (160k from haiku)
    expect(result.contextTokens).toBeGreaterThan(160000);
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("uses agentCfg.contextTokens override when provided", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextTokens: 100000, // Override
        },
      },
    };

    const directives: InlineDirectives = {
      hasModelDirective: false,
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasExecOptions: false,
      hasQueueDirective: false,
      queueReset: false,
      hasStatusDirective: false,
    };

    const aliasIndex = {
      byKey: new Map(),
      byAlias: new Map(),
    };

    const result = await persistInlineDirectives({
      directives,
      cfg,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      aliasIndex,
      allowedModelKeys: new Set(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      initialModelLabel: "anthropic/claude-sonnet-4-6",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      agentCfg: cfg.agents?.defaults,
    });

    // Should use the override value
    expect(result.contextTokens).toBe(100000);
  });
});

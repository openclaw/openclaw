/**
 * Regression test for #18177: elevatedDefault should fall back to "off".
 *
 * Calls the real resolveReplyDirectives with tools.elevated.enabled=true
 * and allowFrom matching, verifying the returned resolvedElevatedLevel
 * is "off" (not "on") when no elevatedDefault is configured.
 */
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";

// Mock only downstream dependencies unrelated to elevated logic
vi.mock("./model-selection.js", () => ({
  createModelSelectionState: vi.fn().mockResolvedValue({
    provider: "anthropic",
    model: "claude-opus-4-5",
    authProfileId: undefined,
    authProfileIdSource: undefined,
  }),
  resolveContextTokens: vi.fn().mockReturnValue(100_000),
}));

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: vi.fn().mockResolvedValue({
    kind: "continue",
    directives: {
      cleaned: "hello",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      hasStatusDirective: false,
    },
    provider: "anthropic",
    model: "claude-opus-4-5",
    contextTokens: 100_000,
  }),
}));

import { resolveReplyDirectives } from "./get-reply-directives.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";
import { createMockTypingController } from "./test-helpers.js";

describe("elevatedDefault fallback (#18177)", () => {
  it("resolvedElevatedLevel falls back to 'off' when elevatedDefault is not configured", async () => {
    const cfg = {
      tools: {
        elevated: {
          enabled: true,
          allowFrom: { telegram: ["user123"] },
        },
      },
    };
    const ctx = {
      From: "telegram:user123",
      AccountId: "primary",
      SessionKey: "main",
      Provider: "telegram",
      Body: "hello",
      CommandBody: "hello",
      RawBody: "hello",
    };
    const sessionCtx = {
      ...ctx,
      BodyStripped: "hello",
      BodyForAgent: "hello",
      BodyForCommands: "hello",
    };
    const sessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      totalTokens: 0,
      compactionCount: 0,
    };
    const typing = createMockTypingController();

    const result = await resolveReplyDirectives({
      ctx: ctx as Parameters<typeof resolveReplyDirectives>[0]["ctx"],
      cfg: cfg as Parameters<typeof resolveReplyDirectives>[0]["cfg"],
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp",
      agentCfg: undefined as unknown as Parameters<typeof resolveReplyDirectives>[0]["agentCfg"],
      sessionCtx: sessionCtx as unknown as Parameters<
        typeof resolveReplyDirectives
      >[0]["sessionCtx"],
      sessionEntry: sessionEntry as Parameters<typeof resolveReplyDirectives>[0]["sessionEntry"],
      sessionStore: { main: sessionEntry } as unknown as Parameters<
        typeof resolveReplyDirectives
      >[0]["sessionStore"],
      sessionKey: "main",
      sessionScope: {} as Parameters<typeof resolveReplyDirectives>[0]["sessionScope"],
      groupResolution: { isGroup: false } as unknown as Parameters<
        typeof resolveReplyDirectives
      >[0]["groupResolution"],
      isGroup: false,
      triggerBodyNormalized: "hello",
      commandAuthorized: true,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: {} as Parameters<typeof resolveReplyDirectives>[0]["aliasIndex"],
      provider: "anthropic",
      model: "claude-opus-4-5",
      hasResolvedHeartbeatModelOverride: false,
      typing,
    });

    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(result.result.elevatedAllowed).toBe(true);
      expect(result.result.elevatedEnabled).toBe(true);
      expect(result.result.resolvedElevatedLevel).toBe("off");
    }
  });

  it("elevated is allowed when tools.elevated.enabled + allowFrom match", () => {
    const result = resolveElevatedPermissions({
      cfg: {
        tools: {
          elevated: {
            enabled: true,
            allowFrom: { telegram: ["user123"] },
          },
        },
      },
      agentId: "main",
      ctx: {
        From: "telegram:user123",
        AccountId: "primary",
        SessionKey: "main",
      } as MsgContext,
      provider: "telegram",
    });

    expect(result.enabled).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("elevated is not allowed when tools.elevated.enabled is false", () => {
    const result = resolveElevatedPermissions({
      cfg: {
        tools: {
          elevated: {
            enabled: false,
            allowFrom: { telegram: ["user123"] },
          },
        },
      },
      agentId: "main",
      ctx: {
        From: "telegram:user123",
        AccountId: "primary",
        SessionKey: "main",
      } as MsgContext,
      provider: "telegram",
    });

    expect(result.enabled).toBe(false);
    expect(result.allowed).toBe(false);
  });
});

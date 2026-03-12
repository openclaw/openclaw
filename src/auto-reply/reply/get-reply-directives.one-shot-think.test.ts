import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn().mockReturnValue({ sandboxed: false }),
}));

vi.mock("../skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-commands.js")>();
  return {
    ...actual,
    listSkillCommandsForWorkspace: vi.fn().mockReturnValue([]),
  };
});

vi.mock("./block-streaming.js", () => ({
  resolveBlockStreamingChunking: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: vi
    .fn()
    .mockImplementation(async ({ directives, provider, model, contextTokens }) => ({
      kind: "continue",
      directives,
      provider,
      model,
      contextTokens,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    })),
}));

vi.mock("./model-selection.js", () => ({
  createModelSelectionState: vi.fn().mockImplementation(async ({ provider, model }) => ({
    provider,
    model,
    resolveDefaultThinkingLevel: vi.fn().mockResolvedValue(undefined),
    resolveDefaultReasoningLevel: vi.fn().mockResolvedValue("off"),
  })),
  resolveContextTokens: vi.fn().mockReturnValue(0),
}));

import { resolveReplyDirectives } from "./get-reply-directives.js";

function baseParams(commandText: string) {
  const sessionEntry: SessionEntry = {
    sessionId: "session-id",
    updatedAt: Date.now(),
  };
  const ctx = buildTestCtx({
    Body: commandText,
    RawBody: commandText,
    CommandBody: commandText,
    BodyForCommands: commandText,
    Provider: "discord",
    Surface: "discord",
    ChatType: "group",
    WasMentioned: true,
    CommandAuthorized: true,
  });
  return {
    ctx,
    cfg: {
      session: {},
      channels: {},
      agents: { defaults: {} },
      messages: {
        groupChat: {
          mentionPatterns: ["@bot"],
        },
      },
    },
    agentId: "default",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {},
    sessionCtx: {
      ...ctx,
      Body: commandText,
      BodyStripped: commandText,
      BodyForCommands: commandText,
      CommandBody: commandText,
    },
    sessionEntry,
    sessionStore: {},
    sessionKey: "session-key",
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: true,
    triggerBodyNormalized: commandText,
    commandAuthorized: true,
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
    aliasIndex: {} as never,
    provider: "openai",
    model: "gpt-5.4",
    hasResolvedHeartbeatModelOverride: false,
    typing: {
      cleanup: vi.fn(),
    } as never,
  } satisfies Parameters<typeof resolveReplyDirectives>[0];
}

describe("resolveReplyDirectives one-shot think", () => {
  it("preserves one-shot think level after stripping leading mentions", async () => {
    const result = await resolveReplyDirectives(baseParams("@bot /think high explain this"));

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected continue result");
    }
    expect(result.result.directives.oneShotThinkLevel).toBe("high");
    expect(result.result.directives.hasThinkDirective).toBe(false);
  });

  it("does not treat mid-text think mentions as one-shot", async () => {
    const result = await resolveReplyDirectives(
      baseParams("@bot compare /think high vs /think low"),
    );

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected continue result");
    }
    expect(result.result.directives.oneShotThinkLevel).toBeUndefined();
  });
});

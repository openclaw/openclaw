import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const emptyAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};

function createTypingController(): TypingController {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: () => {},
  };
}

function createConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: "/tmp/openclaw",
      },
    },
  } as OpenClawConfig;
}

describe("applyInlineDirectiveOverrides trace directives", () => {
  it("returns a directive-only reply for bare /trace", async () => {
    const cfg = createConfig();
    const sessionKey = "agent:main:feishu:chat:dm-1";
    const sessionEntry: SessionEntry = {
      sessionId: "trace-session",
      updatedAt: Date.now(),
      traceLevel: "on",
    };

    const result = await applyInlineDirectiveOverrides({
      ctx: buildTestCtx({
        Provider: "feishu",
        Surface: "feishu",
        Body: "/trace",
        CommandBody: "/trace",
        RawBody: "/trace",
        CommandAuthorized: true,
      }),
      cfg,
      agentId: "main",
      agentDir: "/tmp/openclaw/main",
      agentCfg: cfg.agents?.defaults ?? {},
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: undefined,
      sessionScope: undefined,
      isGroup: false,
      allowTextCommands: true,
      command: {
        surface: "feishu",
        channel: "feishu",
        channelId: "feishu",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "user-1",
        abortKey: "user-1",
        rawBodyNormalized: "/trace",
        commandBodyNormalized: "/trace",
        from: "feishu:user-1",
        to: "feishu:chat:dm-1",
      },
      directives: parseInlineDirectives("/trace"),
      messageProviderKey: "feishu",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: emptyAliasIndex,
      provider: "anthropic",
      model: "claude-opus-4-6",
      modelState: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        resolveDefaultThinkingLevel: async () => "off",
        resolveDefaultReasoningLevel: async () => "off",
        allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
        allowedModelCatalog: [],
        resetModelOverride: false,
        needsModelCatalog: false,
      },
      initialModelLabel: "anthropic/claude-opus-4-6",
      formatModelSwitchEvent: (label) => label,
      resolvedElevatedLevel: "off",
      defaultActivation: () => "always",
      contextTokens: 0,
      typing: createTypingController(),
    });

    expect(result.kind).toBe("reply");
    if (result.kind !== "reply") {
      throw new Error("expected directive-only trace reply");
    }
    expect(result.reply).toEqual({
      text: "Current trace level: on.\nOptions: on, off, raw.",
    });
  });
});

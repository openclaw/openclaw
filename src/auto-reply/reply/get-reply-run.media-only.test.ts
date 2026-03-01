import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPreparedReply } from "./get-reply-run.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn().mockReturnValue("main"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("./queue.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./auto-reasoning.js", () => ({
  resolveAutoThinkingLevel: vi.fn().mockResolvedValue({
    thinkingLevel: "medium",
    source: "auto-meta",
    selector: { used: true, provider: "anthropic", model: "claude-opus-4-1" },
  }),
}));

vi.mock("./session-updates.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
  prependSystemEvents: vi.fn().mockImplementation(async ({ prefixedBodyBase }) => prefixedBodyBase),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

import { runReplyAgent } from "./agent-runner.js";
import { resolveAutoThinkingLevel } from "./auto-reasoning.js";
import { routeReply } from "./route-reply.js";
import { resolveTypingMode } from "./typing-mode.js";

function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      ChatType: "group",
    },
    sessionCtx: {
      Body: "",
      BodyStripped: "",
      ThreadHistoryBody: "Earlier message in this thread",
      MediaPath: "/tmp/input.png",
      Provider: "slack",
      ChatType: "group",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    configuredThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

describe("runPreparedReply media-only handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPreparedReply(baseParams());
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("keeps thread history context on follow-up turns", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
  });

  it("returns the empty-body reply when there is no text and no media", async () => {
    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "slack",
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("omits auth key labels from /new and /reset confirmation messages", async () => {
    await runPreparedReply(
      baseParams({
        resetTriggered: true,
      }),
    );

    const resetNoticeCall = vi.mocked(routeReply).mock.calls[0]?.[0] as
      | { payload?: { text?: string } }
      | undefined;
    expect(resetNoticeCall?.payload?.text).toContain("✅ New session started · model:");
    expect(resetNoticeCall?.payload?.text).not.toContain("🔑");
    expect(resetNoticeCall?.payload?.text).not.toContain("api-key");
    expect(resetNoticeCall?.payload?.text).not.toContain("env:");
  });

  it("skips reset notice when only webchat fallback routing is available", async () => {
    await runPreparedReply(
      baseParams({
        resetTriggered: true,
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
          ChatType: "group",
        },
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          channel: "webchat",
          from: undefined,
          to: undefined,
        } as never,
      }),
    );

    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("uses inbound origin channel for run messageProvider", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:abc",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.messageProvider).toBe("webchat");
  });

  it("passes suppressTyping through typing mode resolution", async () => {
    await runPreparedReply(
      baseParams({
        opts: {
          suppressTyping: true,
        },
      }),
    );

    const call = vi.mocked(resolveTypingMode).mock.calls[0]?.[0] as
      | { suppressTyping?: boolean }
      | undefined;
    expect(call?.suppressTyping).toBe(true);
  });

  it("maps autoReasoningConfig to follow-up run flags", async () => {
    await runPreparedReply(
      baseParams({
        autoReasoningEnabled: false,
        autoReasoningConfig: {
          enabled: true,
          emitGeneratingField: false,
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.autoReasoningEnabled).toBe(true);
    expect(call?.followupRun.run.emitGeneratingField).toBe(false);
  });

  it("uses per-turn auto resolver when configured think is auto", async () => {
    await runPreparedReply(
      baseParams({
        resolvedThinkLevel: undefined,
        configuredThinkLevel: "auto",
        ctx: {
          Body: "debug this issue",
          RawBody: "debug this issue",
          CommandBody: "debug this issue",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "debug this issue",
          BodyStripped: "debug this issue",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );

    expect(vi.mocked(resolveAutoThinkingLevel)).toHaveBeenCalledOnce();
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.thinkLevel).toBe("medium");
    expect(call?.followupRun.run.generatingSource).toBe("auto-meta");
  });

  it("does not overwrite auto session config when effective think is coerced", async () => {
    vi.mocked(resolveAutoThinkingLevel).mockResolvedValueOnce({
      thinkingLevel: "minimal",
      source: "auto-meta",
      selector: { used: false, provider: "openai-codex", model: "gpt-5.3-codex" },
    });

    const sessionEntry = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      configuredThink: "auto",
      thinkingLevel: "auto",
    } as const;
    const sessionStore = { "session-key": { ...sessionEntry } };

    await runPreparedReply(
      baseParams({
        resolvedThinkLevel: undefined,
        configuredThinkLevel: "auto",
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        sessionEntry: sessionStore["session-key"],
        sessionStore,
        ctx: {
          Body: "what is 2+2",
          RawBody: "what is 2+2",
          CommandBody: "what is 2+2",
        },
        sessionCtx: {
          Body: "what is 2+2",
          BodyStripped: "what is 2+2",
          Provider: "slack",
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.followupRun.run.thinkLevel).toBe("low");
    expect(sessionStore["session-key"]?.configuredThink).toBe("auto");
    expect(sessionStore["session-key"]?.thinkingLevel).toBe("auto");
  });

  it("resolves non-off effective think per request and passes it to model invocation", async () => {
    vi.mocked(resolveAutoThinkingLevel)
      .mockResolvedValueOnce({
        thinkingLevel: "minimal",
        source: "auto-meta",
        selector: { used: false, provider: "anthropic", model: "claude-opus-4-1" },
      })
      .mockResolvedValueOnce({
        thinkingLevel: "high",
        source: "auto-meta",
        selector: { used: false, provider: "anthropic", model: "claude-opus-4-1" },
      });

    await runPreparedReply(
      baseParams({
        resolvedThinkLevel: undefined,
        configuredThinkLevel: "auto",
        ctx: {
          Body: "what is 4+4",
          RawBody: "what is 4+4",
          CommandBody: "what is 4+4",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "what is 4+4",
          BodyStripped: "what is 4+4",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );

    await runPreparedReply(
      baseParams({
        resolvedThinkLevel: undefined,
        configuredThinkLevel: "auto",
        ctx: {
          Body: "design a migration strategy for distributed DB failover across regions",
          RawBody: "design a migration strategy for distributed DB failover across regions",
          CommandBody: "design a migration strategy for distributed DB failover across regions",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "design a migration strategy for distributed DB failover across regions",
          BodyStripped: "design a migration strategy for distributed DB failover across regions",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );

    const firstCall = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    const secondCall = vi.mocked(runReplyAgent).mock.calls[1]?.[0];
    expect(firstCall?.followupRun.run.thinkLevel).toBe("minimal");
    expect(secondCall?.followupRun.run.thinkLevel).toBe("high");
    expect(firstCall?.followupRun.run.thinkLevel).not.toBe(secondCall?.followupRun.run.thinkLevel);
    expect(firstCall?.followupRun.run.thinkLevel).not.toBe("off");
    expect(secondCall?.followupRun.run.thinkLevel).not.toBe("off");
  });
});

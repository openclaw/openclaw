import { beforeEach, describe, expect, it, vi } from "vitest";

const routeReplyMock = vi.fn();
const runReplyAgentMock = vi.fn();

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeReplyMock(params),
}));

vi.mock("./agent-runner.js", () => ({
  runReplyAgent: (params: unknown) => runReplyAgentMock(params),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn(async ({ baseBody }: { baseBody: string }) => baseBody),
}));

vi.mock("./session-updates.js", () => ({
  prependSystemEvents: vi.fn(
    async ({ prefixedBodyBase }: { prefixedBodyBase: string }) => prefixedBodyBase,
  ),
  ensureSkillSnapshot: vi.fn(async ({ sessionEntry }: { sessionEntry?: object }) => ({
    sessionEntry,
    systemSent: true,
    skillsSnapshot: {},
  })),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn(() => ""),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn(() => "instant"),
}));

vi.mock("./untrusted-context.js", () => ({
  appendUntrustedContext: vi.fn((body: string) => body),
}));

vi.mock("./queue.js", () => ({
  resolveQueueSettings: vi.fn(() => ({ mode: "interrupt" })),
}));

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn(async () => undefined),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(() => false),
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  resolveEmbeddedSessionLane: vi.fn(() => "lane"),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn(() => 0),
  getQueueSize: vi.fn(() => 0),
}));

import { runPreparedReply } from "./get-reply-run.js";

function baseParams() {
  const typing = {
    cleanup: vi.fn(),
    onReplyStart: vi.fn(async () => {}),
  };

  return {
    ctx: {
      Body: "/new",
      RawBody: "/new",
      CommandBody: "/new",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
    },
    sessionCtx: {
      Body: "/new",
      BodyStripped: "",
      Provider: "whatsapp",
      ChatType: "direct",
      MessageSid: "m1",
    },
    cfg: { session: {} },
    agentId: "main",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      isAuthorizedSender: true,
      abortKey: "main",
      senderIsOwner: true,
      ownerList: [],
    },
    commandSource: "/new",
    allowTextCommands: true,
    directives: { hasThinkDirective: false },
    defaultActivation: "mention",
    resolvedThinkLevel: "low",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: vi.fn(async () => "low"),
    },
    provider: "anthropic",
    model: "claude-opus-4-5",
    typing,
    defaultProvider: "anthropic",
    defaultModel: "anthropic/claude-opus-4-5",
    timeoutMs: 1_000,
    isNewSession: true,
    resetTriggered: true,
    systemSent: false,
    sessionStore: {},
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    abortedLastRun: false,
  } as const;
}

describe("runPreparedReply /new fallback disclosure", () => {
  beforeEach(() => {
    routeReplyMock.mockReset();
    runReplyAgentMock.mockReset();
    runReplyAgentMock.mockResolvedValue(undefined);
  });

  it("does not disclose fallback in /new status line when runtime equals default model", async () => {
    const params = baseParams();

    await runPreparedReply(params as never);

    expect(routeReplyMock).toHaveBeenCalledOnce();
    const call = routeReplyMock.mock.calls[0]?.[0] as { payload?: { text?: string } };
    expect(call.payload?.text).toBe("✅ New session started · model: anthropic/claude-opus-4-5");
  });

  it("discloses fallback in /new status line when runtime differs from default", async () => {
    const params = {
      ...baseParams(),
      provider: "openai",
      model: "gpt-5.2",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    };

    await runPreparedReply(params as never);

    expect(routeReplyMock).toHaveBeenCalledOnce();
    const call = routeReplyMock.mock.calls[0]?.[0] as { payload?: { text?: string } };
    expect(call.payload?.text).toBe(
      "✅ New session started · model: openai/gpt-5.2 (default: anthropic/claude-opus-4-5)",
    );
  });
});

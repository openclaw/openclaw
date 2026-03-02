import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => managerMocks,
}));

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: (sessionKey: string) => bindingServiceMocks.listBySession(sessionKey),
  }),
}));

const { tryDispatchAcpReply } = await import("./dispatch-acp.js");

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  counts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const dispatcher: ReplyDispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    markComplete: vi.fn(),
  };
  return { dispatcher, counts };
}

function setReadyAcpResolution() {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey: "agent:codex-acp:session-1",
    meta: createAcpSessionMeta(),
  });
}

function createAcpConfigWithVisibleToolTags(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

describe("tryDispatchAcpReply", () => {
  beforeEach(() => {
    managerMocks.resolveSession.mockReset();
    managerMocks.runTurn.mockReset();
    managerMocks.getObservabilitySnapshot.mockReset();
    managerMocks.getObservabilitySnapshot.mockReturnValue({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 0 },
    });
    policyMocks.resolveAcpDispatchPolicyError.mockReset();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(null);
    policyMocks.resolveAcpAgentPolicyError.mockReset();
    policyMocks.resolveAcpAgentPolicyError.mockReturnValue(null);
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    messageActionMocks.runMessageAction.mockReset();
    messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.resolveTtsConfig.mockReset();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    sessionMetaMocks.readAcpSessionEntry.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
  });

  it("routes ACP block output to originating channel", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "hello", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher } = createDispatcher();
    const result = await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "reply",
      }),
      cfg: createAcpTestConfig(),
      dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    expect(result?.counts.block).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
      }),
    );
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("edits ACP tool lifecycle updates in place when supported", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-1",
          status: "in_progress",
          title: "Run command",
          text: "Run command (in_progress)",
        });
        await onEvent({
          type: "tool_call",
          tag: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          title: "Run command",
          text: "Run command (completed)",
        });
        await onEvent({ type: "done" });
      },
    );
    routeMocks.routeReply.mockResolvedValueOnce({ ok: true, messageId: "tool-msg-1" });

    const { dispatcher } = createDispatcher();
    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "run tool",
      }),
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(messageActionMocks.runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "edit",
        params: expect.objectContaining({
          messageId: "tool-msg-1",
        }),
      }),
    );
  });

  it("falls back to new tool message when edit fails", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-2",
          status: "in_progress",
          title: "Run command",
          text: "Run command (in_progress)",
        });
        await onEvent({
          type: "tool_call",
          tag: "tool_call_update",
          toolCallId: "call-2",
          status: "completed",
          title: "Run command",
          text: "Run command (completed)",
        });
        await onEvent({ type: "done" });
      },
    );
    routeMocks.routeReply
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2" })
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2-fallback" });
    messageActionMocks.runMessageAction.mockRejectedValueOnce(new Error("edit unsupported"));

    const { dispatcher } = createDispatcher();
    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "run tool",
      }),
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    expect(messageActionMocks.runMessageAction).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle when ACP turn starts, including hidden-only turns", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "status",
          tag: "usage_update",
          text: "usage updated: 1/100",
          used: 1,
          size: 100,
        });
        await onEvent({ type: "done" });
      },
    );
    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "hidden",
      }),
      cfg: createAcpTestConfig(),
      dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      onReplyStart,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "visible", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );
    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "visible",
      }),
      cfg: createAcpTestConfig(),
      dispatcher: createDispatcher().dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      onReplyStart,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });
    expect(onReplyStart).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle once per turn when output is delivered", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();

    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "visible", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );

    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "visible",
      }),
      cfg: createAcpTestConfig(),
      dispatcher: createDispatcher().dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      onReplyStart,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not start reply lifecycle for empty ACP prompt", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "   ",
      }),
      cfg: createAcpTestConfig(),
      dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      onReplyStart,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("surfaces ACP policy errors as final error replies", async () => {
    setReadyAcpResolution();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(
      new AcpRuntimeError("ACP_DISPATCH_DISABLED", "ACP dispatch is disabled by policy."),
    );
    const { dispatcher } = createDispatcher();

    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
        BodyForAgent: "test",
      }),
      cfg: createAcpTestConfig(),
      dispatcher,
      sessionKey: "agent:codex-acp:session-1",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACP_DISPATCH_DISABLED"),
      }),
    );
  });
});

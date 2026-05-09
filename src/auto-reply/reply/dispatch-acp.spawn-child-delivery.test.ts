import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { MediaUnderstandingSkipError } from "../../media-understanding/errors.js";
import { tryDispatchAcpReply } from "./dispatch-acp.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

// Phase 1.2 / Task 6 / Gap 1 — red-light TDD spec for spawn-child outbound delivery.
//
// This file specifies the behavior the supergroup-spawn-child case requires
// once Gap 1 is fixed: an ACP turn whose parent dispatcher gets torn down
// mid-stream must still deliver to a Telegram-bound conversation when the
// session binding exists. The third scenario is expected to fail today;
// that red light is the architectural finding the plan calls out — there
// is no bind-aware persistent dispatcher, so once the locally-passed
// dispatcher's sends start no-oping, child events drop on the floor.
//
// Preamble duplicated from dispatch-acp.tool-stream-supergroup.test.ts;
// share via test-fixtures helper if a third copy lands.

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
  routeReply: vi.fn<
    (_params: unknown) => Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  >(async () => ({ ok: true, messageId: "mock" })),
}));

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "discord" && channelId !== "slack" && channelId !== "telegram") {
      return undefined;
    }
    return {
      outbound: {
        shouldTreatDeliveredTextAsVisible: ({
          kind,
          text,
        }: {
          kind: "tool" | "block" | "final";
          text?: string;
        }) => kind === "block" && typeof text === "string" && text.trim().length > 0,
      },
    };
  }),
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

const mediaUnderstandingMocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (_params: unknown) => undefined),
}));

const diagnosticMocks = vi.hoisted(() => ({
  markDiagnosticSessionProgress: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

const transcriptMocks = vi.hoisted(() => ({
  persistAcpDispatchTranscript: vi.fn(async (_params: unknown) => undefined),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
  unbind: vi.fn<(input: unknown) => Promise<SessionBindingRecord[]>>(async () => []),
}));

vi.mock("./dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => managerMocks,
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      bindingServiceMocks.listBySession(targetSessionKey),
    unbind: (input: unknown) => bindingServiceMocks.unbind(input),
  }),
}));

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  getLoadedChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  normalizeChannelId: (channelId?: string | null) => channelId?.trim().toLowerCase() || null,
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));

vi.mock("./dispatch-acp-media.runtime.js", () => ({
  applyMediaUnderstanding: (params: unknown) =>
    mediaUnderstandingMocks.applyMediaUnderstanding(params),
  isMediaUnderstandingSkipError: (error: unknown): error is MediaUnderstandingSkipError =>
    error instanceof Error && error.name === "MediaUnderstandingSkipError",
  normalizeAttachments: (ctx: { MediaPath?: string; MediaType?: string }) =>
    ctx.MediaPath
      ? [
          {
            path: ctx.MediaPath,
            mime: ctx.MediaType,
            index: 0,
          },
        ]
      : [],
  resolveMediaAttachmentLocalRoots: (params: {
    cfg: { channels?: Record<string, { attachmentRoots?: string[] } | undefined> };
    ctx: { Provider?: string; Surface?: string };
  }) => {
    const channel = params.ctx.Provider ?? params.ctx.Surface ?? "";
    return params.cfg.channels?.[channel]?.attachmentRoots ?? [];
  },
  MediaAttachmentCache: class {
    async getBuffer(): Promise<never> {
      const error = new Error("outside allowed roots");
      error.name = "MediaUnderstandingSkipError";
      throw error;
    }
  },
}));

vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

vi.mock("../../logging/diagnostic.js", () => ({
  markDiagnosticSessionProgress: diagnosticMocks.markDiagnosticSessionProgress,
}));

vi.mock("./dispatch-acp-transcript.runtime.js", () => ({
  persistAcpDispatchTranscript: (params: unknown) =>
    transcriptMocks.persistAcpDispatchTranscript(params),
}));

const sessionKey = "agent:copilot:acp:spawn-child-1";
const boundConversationId = "-100123:topic:323";

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  toolResultMock: ReturnType<typeof vi.fn>;
  blockReplyMock: ReturnType<typeof vi.fn>;
  finalReplyMock: ReturnType<typeof vi.fn>;
  counts: Record<"tool" | "block" | "final", number>;
  failedCounts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const failedCounts = { tool: 0, block: 0, final: 0 };
  const toolResultMock = vi.fn(() => true);
  const blockReplyMock = vi.fn(() => true);
  const finalReplyMock = vi.fn(() => true);
  const dispatcher: ReplyDispatcher = {
    sendToolResult: toolResultMock,
    sendBlockReply: blockReplyMock,
    sendFinalReply: finalReplyMock,
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    getFailedCounts: vi.fn(() => ({ ...failedCounts })),
    markComplete: vi.fn(),
  };
  return { dispatcher, toolResultMock, blockReplyMock, finalReplyMock, counts, failedCounts };
}

function setReadyAcpResolution() {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: createAcpSessionMeta({ agent: "copilot" }),
  });
}

function createLiveStreamConfig(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        coalesceIdleMs: 0,
        maxChunkChars: 1024,
        tagVisibility: {
          tool_call: true,
          agent_message_chunk: true,
        },
      },
    },
  });
}

function createFinalOnlyStreamConfig(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "final_only",
        coalesceIdleMs: 0,
        maxChunkChars: 1024,
        tagVisibility: {
          tool_call: true,
          agent_message_chunk: true,
        },
      },
    },
  });
}

function createTelegramBinding(): SessionBindingRecord {
  return {
    bindingId: "binding-1",
    targetSessionKey: sessionKey,
    targetKind: "session",
    conversation: {
      channel: "telegram",
      accountId: "default",
      conversationId: boundConversationId,
    },
    status: "active",
    boundAt: Date.now(),
  };
}

async function runSpawnChildDispatch(params: {
  bodyForAgent: string;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
}) {
  return tryDispatchAcpReply({
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      IsForum: true,
      SessionKey: sessionKey,
      BodyForAgent: params.bodyForAgent,
    }),
    cfg: params.cfg,
    dispatcher: params.dispatcher,
    sessionKey,
    inboundAudio: false,
    shouldRouteToOriginating: false,
    shouldSendToolSummaries: true,
    bypassForCommand: false,
    recordProcessed: vi.fn(),
    markIdle: vi.fn(),
  });
}

describe("tryDispatchAcpReply spawn-child outbound delivery (Gap 1)", () => {
  beforeEach(() => {
    managerMocks.resolveSession.mockReset();
    managerMocks.runTurn.mockReset();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent?: (event: unknown) => Promise<void> }) => {
        await onEvent?.({ type: "done" });
      },
    );
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
    channelPluginMocks.getChannelPlugin.mockClear();
    messageActionMocks.runMessageAction.mockReset();
    messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.resolveTtsConfig.mockReset();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    mediaUnderstandingMocks.applyMediaUnderstanding.mockReset();
    mediaUnderstandingMocks.applyMediaUnderstanding.mockResolvedValue(undefined);
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
    transcriptMocks.persistAcpDispatchTranscript.mockClear();
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
    bindingServiceMocks.unbind.mockReset();
    bindingServiceMocks.unbind.mockResolvedValue([]);
  });

  it("live mode delivers tool_call summary then assistant text chunk to a telegram supergroup forum", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-1",
          status: "in_progress",
          title: "Run review",
          text: "review pr-640",
        });
        await onEvent({
          type: "text_delta",
          tag: "agent_message_chunk",
          text: "Reviewing PR #640.\n\n",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, blockReplyMock } = createDispatcher();
    await runSpawnChildDispatch({
      bodyForAgent: "spawn child review",
      cfg: createLiveStreamConfig(),
      dispatcher,
    });

    // The tool_call summary must be delivered as a "tool" payload before the
    // assistant text chunk lands as a "block" payload.
    expect(toolResultMock).toHaveBeenCalledTimes(1);
    expect(toolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Run review") }),
    );
    expect(blockReplyMock).toHaveBeenCalled();
    expect(blockReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Reviewing PR #640.") }),
    );

    const toolOrder = toolResultMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const blockOrder = blockReplyMock.mock.invocationCallOrder[0] ?? -1;
    expect(toolOrder).toBeLessThan(blockOrder);
  });

  it("final_only mode buffers tool + text and emits a single consolidated end-of-turn delivery", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-2",
          status: "in_progress",
          title: "Run review",
          text: "review pr-640",
        });
        await onEvent({
          type: "text_delta",
          tag: "agent_message_chunk",
          text: "Reviewing PR #640. Looks good.",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, finalReplyMock } = createDispatcher();
    await runSpawnChildDispatch({
      bodyForAgent: "spawn child review",
      cfg: createFinalOnlyStreamConfig(),
      dispatcher,
    });

    // final_only flushes buffered tool deliveries on `done` and emits the
    // accumulated assistant text as a single "final" payload (not "block"),
    // preserving TTS mode semantics: when TTS mode is "final", non-final kinds
    // would be skipped by maybeApplyAcpTts.
    expect(toolResultMock).toHaveBeenCalledTimes(1);
    expect(toolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Run review") }),
    );
    expect(finalReplyMock).toHaveBeenCalledTimes(1);
    expect(finalReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Reviewing PR #640.") }),
    );
  });

  it("delivers spawn-child events after the parent dispatcher tears down mid-stream when a session binding exists", async () => {
    setReadyAcpResolution();
    bindingServiceMocks.listBySession.mockReturnValue([createTelegramBinding()]);

    // The parent dispatcher: the real production failure mode is that send*()
    // returns true (payload is enqueued on the dispatcher's sendChain), but the
    // async transport in the sendChain rejects, incrementing failedCounts. Later
    // calls to deliver() check getFailedCounts() and detect the transport is
    // failing, then route via bindings instead.
    //
    // We simulate this by having the first tool_call send succeed (send*() returns
    // true, failedCounts stays zero), then after "parent teardown" we update
    // failedCounts to reflect an async transport failure. The next deliver() call
    // sees the failure and routes via the session binding.
    const { dispatcher, toolResultMock, failedCounts } = createDispatcher();

    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        // Pre-teardown event — the parent dispatcher transport is healthy.
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-3",
          status: "in_progress",
          title: "Run review",
          text: "starting",
        });

        // Simulate the parent's async transport having failed: in production this
        // happens when the sendChain's deliver() rejects and the .catch() handler
        // increments failedCounts. We replicate that state here so the next
        // deliver() call in the delivery coordinator sees a failing dispatcher
        // and routes via bindings instead.
        failedCounts.tool = 1;
        dispatcher.markComplete();

        // Post-teardown events from the still-running spawn child.
        await onEvent({
          type: "text_delta",
          tag: "agent_message_chunk",
          text: "Streaming continues after parent run ended.",
        });
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-4",
          status: "completed",
          title: "Finalize",
          text: "done",
        });
        await onEvent({ type: "done" });
      },
    );

    await runSpawnChildDispatch({
      bodyForAgent: "spawn child review",
      cfg: createLiveStreamConfig(),
      dispatcher,
    });

    // Pre-teardown event lands on the parent dispatcher.
    expect(toolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Run review") }),
    );

    // Post-teardown events must reach the user via the bind-aware fallback path.
    // The delivery coordinator detects prior async transport failures via
    // getFailedCounts(), then routes via the session binding service to the bound
    // telegram conversation via routeReply — independent of the parent's run.
    expect(bindingServiceMocks.listBySession).toHaveBeenCalledWith(sessionKey);
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: boundConversationId,
        payload: expect.objectContaining({
          text: expect.stringContaining("Streaming continues after parent run ended."),
        }),
      }),
    );
  });

  it("fails closed when multiple session bindings exist and requester context is missing — no delivery, no broadcast", async () => {
    setReadyAcpResolution();
    // Two active bindings for the same session — ambiguous without requester context.
    const binding1: SessionBindingRecord = {
      bindingId: "binding-a",
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100111:topic:100",
      },
      status: "active",
      boundAt: Date.now(),
    };
    const binding2: SessionBindingRecord = {
      bindingId: "binding-b",
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100222:topic:200",
      },
      status: "active",
      boundAt: Date.now(),
    };
    bindingServiceMocks.listBySession.mockReturnValue([binding1, binding2]);

    const { dispatcher, failedCounts } = createDispatcher();

    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        // Pre-teardown event.
        await onEvent({
          type: "tool_call",
          tag: "tool_call",
          toolCallId: "call-5",
          status: "in_progress",
          title: "Run review",
          text: "starting",
        });

        // Simulate async transport failure.
        failedCounts.tool = 1;
        dispatcher.markComplete();

        // Post-teardown event.
        await onEvent({
          type: "text_delta",
          tag: "agent_message_chunk",
          text: "Ambiguous binding output.",
        });
        await onEvent({ type: "done" });
      },
    );

    // Use a ctx with an empty To field so no requester conversationId can be built,
    // forcing the bind-aware router into the ambiguous/fail-closed path.
    await tryDispatchAcpReply({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        IsForum: true,
        SessionKey: sessionKey,
        BodyForAgent: "spawn child review",
        To: "",
      }),
      cfg: createLiveStreamConfig(),
      dispatcher,
      sessionKey,
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      bypassForCommand: false,
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    });

    // With multiple bindings and no requester context, the fallback must fail
    // closed: routeReply must NOT be called for either bound conversation.
    // Broadcasting would leak private child output to unrelated chats.
    expect(routeMocks.routeReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: binding1.conversation.conversationId }),
    );
    expect(routeMocks.routeReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: binding2.conversation.conversationId }),
    );
  });
});

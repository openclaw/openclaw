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

// Catalog finding #12 — regression spec for `agent_thought_chunk` delivery.
//
// Fix: reorder guards in acp-projector.ts so the operator-tunable
// tagVisibility.agent_thought_chunk flag is authoritative for stream="thought"
// events. Also guards against untagged thought-stream leakage (security).
//
// Preamble duplicated from dispatch-acp.tool-stream-supergroup.test.ts and
// dispatch-acp.spawn-child-delivery.test.ts. TODO: share via test-fixtures
// helper if a fourth copy lands.

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

const sessionKey = "agent:copilot:acp:thought-chunk-1";

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  toolResultMock: ReturnType<typeof vi.fn>;
  blockReplyMock: ReturnType<typeof vi.fn>;
  finalReplyMock: ReturnType<typeof vi.fn>;
  counts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const toolResultMock = vi.fn(() => true);
  const blockReplyMock = vi.fn(() => true);
  const finalReplyMock = vi.fn(() => true);
  const dispatcher: ReplyDispatcher = {
    sendToolResult: toolResultMock,
    sendBlockReply: blockReplyMock,
    sendFinalReply: finalReplyMock,
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
  return { dispatcher, toolResultMock, blockReplyMock, finalReplyMock, counts };
}

function setReadyAcpResolution() {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: createAcpSessionMeta({ agent: "copilot" }),
  });
}

// Live mode so we observe intermediate flushes rather than only an
// end-of-turn consolidated payload (final_only would mask whether the
// thought-stream event reached the deliver path before `done`).
function createLiveStreamConfig(params: { thoughtVisible: boolean }): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        coalesceIdleMs: 0,
        maxChunkChars: 1024,
        tagVisibility: {
          agent_message_chunk: true,
          agent_thought_chunk: params.thoughtVisible,
        },
      },
    },
  });
}

async function runThoughtDispatch(params: {
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

describe("tryDispatchAcpReply agent_thought_chunk delivery (catalog #12)", () => {
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

  it("hides thought chunks when tagVisibility.agent_thought_chunk defaults to false", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          tag: "agent_thought_chunk",
          stream: "thought",
          text: "Thinking about the problem...",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, blockReplyMock, finalReplyMock } = createDispatcher();
    await runThoughtDispatch({
      bodyForAgent: "think out loud",
      cfg: createLiveStreamConfig({ thoughtVisible: false }),
      dispatcher,
    });

    // No deliver call should carry the thought content when visibility=false.
    expect(toolResultMock).not.toHaveBeenCalled();
    expect(blockReplyMock).not.toHaveBeenCalled();
    expect(finalReplyMock).not.toHaveBeenCalled();
  });

  it("delivers thought chunks when tagVisibility.agent_thought_chunk=true", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          tag: "agent_thought_chunk",
          stream: "thought",
          text: "Thinking about the problem...",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, blockReplyMock, finalReplyMock } = createDispatcher();
    await runThoughtDispatch({
      bodyForAgent: "think out loud",
      cfg: createLiveStreamConfig({ thoughtVisible: true }),
      dispatcher,
    });

    // Asserting on the union of dispatcher calls (any of tool/block/final)
    // carrying the thought text avoids over-specifying which kind the fix
    // routes through.
    const thoughtCalls = [
      ...toolResultMock.mock.calls,
      ...blockReplyMock.mock.calls,
      ...finalReplyMock.mock.calls,
    ].filter((call) => {
      const payload = call[0] as { text?: string } | undefined;
      return (
        typeof payload?.text === "string" && payload.text.includes("Thinking about the problem")
      );
    });
    expect(thoughtCalls.length).toBeGreaterThan(0);
  });

  it("drops unknown-stream events even when the tag is explicitly visible", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          tag: "agent_thought_chunk",
          stream: "diagnostic",
          text: "Internal diagnostic trace.",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, blockReplyMock, finalReplyMock } = createDispatcher();
    await runThoughtDispatch({
      bodyForAgent: "think out loud",
      cfg: createLiveStreamConfig({ thoughtVisible: true }),
      dispatcher,
    });

    // The stream allow-list ("output" | "thought") is enforced before the
    // visibility check. An event with stream="diagnostic" must be dropped
    // regardless of tagVisibility.agent_thought_chunk=true. This proves the
    // visibility flag cannot bypass the stream allow-list.
    expect(toolResultMock).not.toHaveBeenCalled();
    expect(blockReplyMock).not.toHaveBeenCalled();
    expect(finalReplyMock).not.toHaveBeenCalled();
  });

  it("drops thought-stream events that carry no tag even when agent_thought_chunk visibility=true", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          // no tag — backend omitted it
          stream: "thought",
          text: "Untagged internal reasoning.",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, blockReplyMock, finalReplyMock } = createDispatcher();
    await runThoughtDispatch({
      bodyForAgent: "think out loud",
      cfg: createLiveStreamConfig({ thoughtVisible: true }),
      dispatcher,
    });

    // Security gate: isAcpTagVisible returns true for undefined tags, so
    // without an explicit thought-tag guard an untagged stream="thought" event
    // would reach delivery even though no operator opt-in can be verified.
    // The projector must drop it before consulting visibility.
    expect(toolResultMock).not.toHaveBeenCalled();
    expect(blockReplyMock).not.toHaveBeenCalled();
    expect(finalReplyMock).not.toHaveBeenCalled();
  });

  it("control: delivers visible output-stream agent_message_chunk text_delta", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          tag: "agent_message_chunk",
          stream: "output",
          text: "Visible output text.",
        });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher, toolResultMock, blockReplyMock, finalReplyMock } = createDispatcher();
    await runThoughtDispatch({
      bodyForAgent: "say something",
      cfg: createLiveStreamConfig({ thoughtVisible: true }),
      dispatcher,
    });

    // Sanity check: this proves the test infrastructure can route a
    // text_delta event to a deliver call. If this fails, the RED in the
    // previous test is a setup bug, not a real finding.
    const visibleCalls = [
      ...toolResultMock.mock.calls,
      ...blockReplyMock.mock.calls,
      ...finalReplyMock.mock.calls,
    ].filter((call) => {
      const payload = call[0] as { text?: string } | undefined;
      return typeof payload?.text === "string" && payload.text.includes("Visible output text");
    });
    expect(visibleCalls.length).toBeGreaterThan(0);
  });
});

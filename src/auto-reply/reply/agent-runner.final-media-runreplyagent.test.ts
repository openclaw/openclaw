import path from "node:path";
import { assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const executeAgentTurnMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-selection.js")>()),
  isCliProvider: () => false,
}));

vi.mock("../../agents/sandbox/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox/context.js")>()),
  ensureSandboxWorkspaceForSession: async () => null,
  prepareSandboxWorkspaceForSession: async () => null,
}));

vi.mock("../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostic-events.js")>()),
  emitTrustedDiagnosticEvent: vi.fn(),
  isDiagnosticsEnabled: () => false,
}));

vi.mock("../../infra/diagnostics-timeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostics-timeline.js")>()),
  measureDiagnosticsTimelineSpan: async (_name: string, run: () => unknown) => await run(),
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

vi.mock("./agent-runner-failure-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-failure-reply.js")>()),
  buildKnownAgentRunFailureReplyPayload: vi.fn(() => undefined),
  markPostCompactionModelFailurePayload: (_failure: true | undefined, payload: unknown) => payload,
}));

vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: (...args: unknown[]) => executeAgentTurnMock(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) => ({
    sessionEntry,
    outcome: "skipped",
  }),
  runSessionCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) =>
    sessionEntry,
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: async (config: unknown) => config,
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  refreshQueuedFollowupSession: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: async () => undefined,
}));

const { runReplyAgent } = await import("./agent-runner-run.js");

type AgentTurnExecutionResult = Awaited<
  ReturnType<typeof import("./agent-runner-execution.js").executeAgentTurn>
>;
type AgentTurnParams = Parameters<typeof import("./agent-runner-execution.js").executeAgentTurn>[0];

function makeRunReplyAgentParams(
  blockStreamingEnabled = false,
): Parameters<typeof runReplyAgent>[0] {
  const provider = "telegram";
  const prompt = "generate chart";
  const replyOperation = createReplyOperation({
    sessionKey: "main",
    sessionId: "session",
    resetTriggered: false,
  });
  onTestFinished(() => replyOperation.complete());

  return {
    commandBody: prompt,
    followupRun: createMockFollowupRun({
      prompt,
      run: { agentDir: "/tmp/agent", messageProvider: provider, workspaceDir: "/tmp/workspace" },
    }),
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" },
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: provider,
      Surface: provider,
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
    },
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    replyOperation,
    ...(blockStreamingEnabled ? { opts: { onBlockReply: vi.fn(async () => {}) } } : {}),
  };
}

describe("runReplyAgent final MEDIA replies", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    executeAgentTurnMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockReset();
    enqueueFollowupRunMock.mockReset();

    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl)),
    }));
  });

  it.each([
    { mediaUrl: "https://example.invalid/pending.png", audioAsVoice: false },
    { mediaUrl: "https://example.invalid/pending.opus", audioAsVoice: true },
  ])("keeps pending tool media after NO_REPLY: $mediaUrl", async ({ mediaUrl, audioAsVoice }) => {
    executeAgentTurnMock.mockResolvedValueOnce({
      runId: "silent-media-test",
      outcome: {
        kind: "settled",
        status: "ok",
        result: {
          payloads: [{ text: "Unsent" }, { text: "Caption", mediaUrl, audioAsVoice }],
          meta: {
            durationMs: 0,
            finalAssistantRawText: "NO_REPLY",
            terminalReply: { disposition: "silent" },
          },
        },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
      },
    } satisfies AgentTurnExecutionResult);

    const result = await runReplyAgent(makeRunReplyAgentParams());
    const payloads = Array.isArray(result) ? result : result ? [result] : [];
    expect(payloads).toMatchObject([{ mediaUrl, audioAsVoice }]);
    expect(payloads[0]?.text).toBeUndefined();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("uses one runReplyAgent media context for block and final MEDIA replies", async () => {
    let stagedIndex = 0;
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => {
      return {
        path: path.join("/tmp/outbound-media", `${++stagedIndex}-${path.basename(mediaUrl)}`),
      };
    });
    executeAgentTurnMock.mockImplementationOnce(async (params: AgentTurnParams) => {
      const { buildReplyPayloads } = await vi.importActual<
        typeof import("./agent-runner-payloads.js")
      >("./agent-runner-payloads.js");
      const normalizeMediaPaths = params.replyMediaContext?.normalizePayload;
      assert(normalizeMediaPaths, "runReplyAgent must pass replyMediaContext to the agent turn");
      const commonParams = {
        isHeartbeat: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "all" as const,
        normalizeMediaPaths,
      };
      const blockPayloads = await buildReplyPayloads({
        ...commonParams,
        payloads: [{ text: "block\nMEDIA:./out/chart.png" }],
      });
      const finalPayloads = await buildReplyPayloads({
        ...commonParams,
        payloads: [{ text: "final\nMEDIA:./out/chart.png" }],
      });
      expect(blockPayloads.replyPayloads[0]).toMatchObject({
        text: "block",
        mediaUrl: "/tmp/outbound-media/1-chart.png",
      });
      const payload = finalPayloads.replyPayloads[0];
      assert(payload, "expected parsed final payload");
      return {
        runId: "media-test",
        outcome: { kind: "rejected", payload },
      } satisfies AgentTurnExecutionResult;
    });

    const result = await runReplyAgent(makeRunReplyAgentParams(true));

    assert(result && !Array.isArray(result), "expected single reply payload");
    expect(result).toMatchObject({
      text: "final",
      mediaUrl: "/tmp/outbound-media/1-chart.png",
      mediaUrls: ["/tmp/outbound-media/1-chart.png"],
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });
});

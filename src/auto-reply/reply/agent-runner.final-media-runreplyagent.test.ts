import path from "node:path";
import { assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { createSettledExecution } from "./followup-delivery.test-helpers.js";
import { createMockFollowupRun, createReplyParams } from "./test-helpers.js";

const executeAgentTurnMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("../../agents/sandbox/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox/context.js")>()),
  ensureSandboxWorkspaceForSession: async () => null,
  prepareSandboxWorkspaceForSession: async () => null,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
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

const { runReplyAgent } = await import("./agent-runner-run.js");

type AgentTurnExecutionResult = Awaited<
  ReturnType<typeof import("./agent-runner-execution.js").executeAgentTurn>
>;
type AgentTurnParams = Parameters<typeof import("./agent-runner-execution.js").executeAgentTurn>[0];

function makeRunReplyAgentParams(
  blockStreamingEnabled = false,
): Parameters<typeof runReplyAgent>[0] {
  const replyOperation = createReplyOperation({
    sessionKey: "main",
    sessionId: "session",
    resetTriggered: false,
  });
  onTestFinished(() => replyOperation.complete());

  const followupRun = createMockFollowupRun({ run: { messageProvider: "telegram" } });
  return createReplyParams(followupRun, {
    sessionCtx: {
      Provider: "telegram",
      Surface: "telegram",
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
    },
    defaultModel: "anthropic/claude",
    blockStreamingEnabled,
    typingMode: "instant",
    replyOperation,
    ...(blockStreamingEnabled ? { opts: { onBlockReply: vi.fn(async () => {}) } } : {}),
  });
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
    const execution = createSettledExecution("NO_REPLY");
    execution.outcome.result.payloads = [
      { text: "Unsent" },
      { text: "Caption", mediaUrl, audioAsVoice },
    ];
    executeAgentTurnMock.mockResolvedValueOnce(execution satisfies AgentTurnExecutionResult);

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
      const parse = async (text: string) =>
        (
          await buildReplyPayloads({
            blockStreamingEnabled: false,
            blockReplyPipeline: null,
            replyToMode: "all",
            normalizeMediaPaths,
            payloads: [{ text: `${text}\nMEDIA:./out/chart.png` }],
          })
        ).replyPayloads[0];
      expect(await parse("block")).toMatchObject({
        text: "block",
        mediaUrl: "/tmp/outbound-media/1-chart.png",
      });
      const payload = await parse("final");
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
      attachments: [{ name: "chart.png", mimeType: "image/png", trustedLocalMedia: true }],
      trustedLocalMedia: true,
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });
});

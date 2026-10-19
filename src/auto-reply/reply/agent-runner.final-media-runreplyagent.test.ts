// Tests final media delivery through the run-reply-agent path.
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const executeAgentTurnMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const scheduleFollowupDrainMock = vi.fn();

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: () => false,
  };
});

vi.mock("../../agents/sandbox/context.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/sandbox/context.js")>(
    "../../agents/sandbox/context.js",
  );
  return {
    ...actual,
    ensureSandboxWorkspaceForSession: async () => null,
    prepareSandboxWorkspaceForSession: async () => null,
  };
});

vi.mock("../../infra/diagnostic-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/diagnostic-events.js")>(
    "../../infra/diagnostic-events.js",
  );
  return {
    ...actual,
    emitTrustedDiagnosticEvent: vi.fn(),
    isDiagnosticsEnabled: () => false,
  };
});

vi.mock("../../infra/diagnostics-timeline.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/diagnostics-timeline.js")>(
    "../../infra/diagnostics-timeline.js",
  );
  return {
    ...actual,
    measureDiagnosticsTimelineSpan: async (_name: string, run: () => unknown) => await run(),
  };
});

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

vi.mock("./agent-runner-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  return {
    ...actual,
    resolveQueuedReplyExecutionConfig: async (config: unknown) => config,
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
    refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
    scheduleFollowupDrain: (...args: unknown[]) => scheduleFollowupDrainMock(...args),
  };
});

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: async () => undefined,
}));

const { runReplyAgent } = await import("./agent-runner-run.js");

type AgentTurnExecutionResult = Awaited<
  ReturnType<typeof import("./agent-runner-execution.js").executeAgentTurn>
>;

function makeRunReplyAgentParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> = {},
): Parameters<typeof runReplyAgent>[0] {
  const provider = "telegram";
  const workspaceDir = "/tmp/workspace";
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
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        messageProvider: provider,
        workspaceDir,
      },
    }) as unknown as FollowupRun,
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" } as QueueSettings,
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
    } as unknown as TemplateContext,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    replyOperation,
    ...overrides,
  };
}

describe("runReplyAgent final MEDIA replies", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    executeAgentTurnMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    scheduleFollowupDrainMock.mockReset();

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
          payloads: [
            { text: "Unsent confirmation" },
            { text: "Unsent media caption", mediaUrl, audioAsVoice },
          ],
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
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      mediaUrl,
      audioAsVoice,
    });
    expect(payloads[0]?.text).toBeUndefined();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("uses one runReplyAgent media context for block and final MEDIA replies", async () => {
    let stagedIndex = 0;
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => {
      stagedIndex += 1;
      return {
        path: path.join("/tmp/outbound-media", `${stagedIndex}-${path.basename(mediaUrl)}`),
      };
    });
    executeAgentTurnMock.mockImplementationOnce(async (params: unknown) => {
      const { buildReplyPayloads } = await vi.importActual<
        typeof import("./agent-runner-payloads.js")
      >("./agent-runner-payloads.js");
      const runnerParams = params as {
        replyMediaContext?: {
          normalizePayload?: (payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
          }) => Promise<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
        };
      };
      const normalizeMediaPaths = runnerParams.replyMediaContext?.normalizePayload;
      if (!normalizeMediaPaths) {
        throw new Error("runReplyAgent did not pass replyMediaContext to the agent turn");
      }
      const commonParams = {
        isHeartbeat: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "all" as const,
        replyToChannel: "telegram" as const,
        currentMessageId: "msg-1",
        messageProvider: "telegram",
        originatingChannel: "telegram" as const,
        originatingTo: "chat-1",
        accountId: "default",
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
      if (!payload) {
        throw new Error("expected parsed final payload");
      }
      return {
        runId: "media-test",
        outcome: { kind: "rejected", payload },
      } satisfies AgentTurnExecutionResult;
    });

    const result = await runReplyAgent(
      makeRunReplyAgentParams({
        blockStreamingEnabled: true,
        opts: { onBlockReply: vi.fn(async () => {}) },
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) {
      throw new Error("expected single reply payload");
    }
    expect(result).toMatchObject({
      text: "final",
      mediaUrl: "/tmp/outbound-media/1-chart.png",
      mediaUrls: ["/tmp/outbound-media/1-chart.png"],
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });
});

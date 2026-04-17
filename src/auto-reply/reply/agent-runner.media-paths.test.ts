import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const isEmbeddedPiRunActiveMock = vi.fn(() => false);
const isEmbeddedPiRunStreamingMock = vi.fn(() => false);
const queueEmbeddedPiMessageMock = vi.fn(() => false);
const resolveEmbeddedSessionLaneMock = vi.fn();
const waitForEmbeddedPiRunEndMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const scheduleFollowupDrainMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const createReplyMediaPathNormalizerRuntimeMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
  compactEmbeddedPiSession: compactEmbeddedPiSessionMock,
  isEmbeddedPiRunActive: isEmbeddedPiRunActiveMock,
  isEmbeddedPiRunStreaming: isEmbeddedPiRunStreamingMock,
  queueEmbeddedPiMessage: queueEmbeddedPiMessageMock,
  resolveEmbeddedSessionLane: resolveEmbeddedSessionLaneMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  waitForEmbeddedPiRunEnd: waitForEmbeddedPiRunEndMock,
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: enqueueFollowupRunMock,
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
  scheduleFollowupDrain: scheduleFollowupDrainMock,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

// Spy on the .runtime import path used by agent-runner-execution.ts so we can assert
// that the fix prevents a second normalizer from being created inside runAgentTurnWithFallback.
vi.mock("./reply-media-paths.runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./reply-media-paths.runtime.js")>();
  return {
    createReplyMediaPathNormalizer: (...args: Parameters<typeof mod.createReplyMediaPathNormalizer>) => {
      createReplyMediaPathNormalizerRuntimeMock(...args);
      return mod.createReplyMediaPathNormalizer(...args);
    },
  };
});

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

describe("runReplyAgent media path normalization", () => {
  beforeEach(async () => {
    vi.resetModules();
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    abortEmbeddedPiRunMock.mockReset();
    compactEmbeddedPiSessionMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReturnValue(false);
    isEmbeddedPiRunStreamingMock.mockReset();
    isEmbeddedPiRunStreamingMock.mockReturnValue(false);
    queueEmbeddedPiMessageMock.mockReset();
    queueEmbeddedPiMessageMock.mockReturnValue(false);
    resolveEmbeddedSessionLaneMock.mockReset();
    waitForEmbeddedPiRunEndMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    scheduleFollowupDrainMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockReset();
    createReplyMediaPathNormalizerRuntimeMock.mockReset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl)),
    }));
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (...args: unknown[]) => Promise<unknown>;
      }) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes final MEDIA replies against the run workspace", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "MEDIA:./out/generated.png" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    const result = await runReplyAgent({
      commandBody: "generate",
      followupRun: createMockFollowupRun({
        prompt: "generate",
        run: {
          agentId: "main",
          agentDir: "/tmp/agent",
          messageProvider: "telegram",
          workspaceDir: "/tmp/workspace",
        },
      }) as unknown as FollowupRun,
      queueKey: "main",
      resolvedQueue: { mode: "interrupt" } as QueueSettings,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing: createMockTypingController(),
      sessionCtx: {
        Provider: "telegram",
        Surface: "telegram",
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
    });

    expect(result).toMatchObject({
      mediaUrl: "/tmp/outbound-media/generated.png",
      mediaUrls: ["/tmp/outbound-media/generated.png"],
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledWith(
      path.join("/tmp/workspace", "out", "generated.png"),
      5 * 1024 * 1024,
      expect.objectContaining({
        mediaAccess: expect.objectContaining({
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
  });

  it("does not create a second normalizer inside runAgentTurnWithFallback when onBlockReply is provided", async () => {
    // Regression test for openclaw/openclaw#68056.
    // Before the fix, runAgentTurnWithFallback always called createReplyMediaPathNormalizer
    // from reply-media-paths.runtime.js to build its own normalizer instance — separate from
    // the one agent-runner.ts created and passed to buildReplyPayloads.  Two separate
    // persistedMediaBySource caches meant the same source could be persisted twice (two UUID
    // outbound files, two WhatsApp sends).
    //
    // After the fix, agent-runner.ts passes its normalizer into runAgentTurnWithFallback, so
    // the .runtime import path is never called from inside that function.
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    await runReplyAgent({
      commandBody: "generate chart",
      followupRun: createMockFollowupRun({
        prompt: "generate chart",
        run: {
          agentId: "main",
          agentDir: "/tmp/agent",
          messageProvider: "whatsapp",
          workspaceDir: "/tmp/workspace",
        },
      }) as unknown as FollowupRun,
      queueKey: "main",
      resolvedQueue: { mode: "interrupt" } as QueueSettings,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing: createMockTypingController(),
      sessionCtx: {
        Provider: "whatsapp",
        Surface: "whatsapp",
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
      opts: {
        onBlockReply: vi.fn(),
      },
    });

    // The .runtime import is only used by agent-runner-execution.ts.  After the fix,
    // runAgentTurnWithFallback receives the normalizer from the caller and never
    // calls createReplyMediaPathNormalizer itself.
    expect(createReplyMediaPathNormalizerRuntimeMock).not.toHaveBeenCalled();
  });
});

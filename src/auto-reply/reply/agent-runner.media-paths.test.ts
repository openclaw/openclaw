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
const readPathWithinRootMock = vi.fn();
const saveMediaBufferMock = vi.fn();

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

vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/fs-safe.js")>();
  return {
    ...actual,
    readPathWithinRoot: readPathWithinRootMock,
  };
});

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return {
    ...actual,
    saveMediaBuffer: saveMediaBufferMock,
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
    readPathWithinRootMock.mockReset();
    readPathWithinRootMock.mockResolvedValue({
      buffer: Buffer.from("generated-media"),
      realPath: "/tmp/workspace/out/generated.png",
      stat: { size: 15 } as never,
    });
    saveMediaBufferMock.mockReset();
    saveMediaBufferMock.mockResolvedValue({
      id: "generated.png",
      path: "/tmp/openclaw-state/media/outbound/generated.png",
      size: 15,
    });
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
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
      mediaUrl: "/tmp/openclaw-state/media/outbound/generated.png",
      mediaUrls: ["/tmp/openclaw-state/media/outbound/generated.png"],
    });
    expect(readPathWithinRootMock).toHaveBeenCalledWith({
      rootDir: "/tmp/workspace",
      filePath: path.join("/tmp/workspace", "out", "generated.png"),
      maxBytes: 5 * 1024 * 1024,
    });
    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      undefined,
      "outbound",
      undefined,
      "generated.png",
    );
  });
});

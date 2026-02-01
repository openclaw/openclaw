import { describe, expect, it, vi } from "vitest";

import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const queueEmbeddedPiMessageMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const getActiveRunThreadContextMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: (...args: unknown[]) => queueEmbeddedPiMessageMock(...args),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(true),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(true),
  getActiveRunThreadContext: (...args: unknown[]) => getActiveRunThreadContextMock(...args),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function createFollowupRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "slack",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  } as FollowupRun;
}

describe("runReplyAgent steer mode thread routing", () => {
  it("skips fast steer when incoming thread differs from active run thread", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();
    getActiveRunThreadContextMock.mockClear();

    // Active run is in a different thread (or no thread)
    getActiveRunThreadContextMock.mockReturnValue(undefined);
    // Steer would succeed if attempted
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "slack",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Message from a different thread than the active run
    const followupRun = createFollowupRun({
      originatingThreadId: "1706742543.891709", // Slack thread timestamp
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "steer" } as QueueSettings,
      shouldSteer: true,
      shouldFollowup: false,
      isActive: true,
      isStreaming: true,
      typing,
      sessionCtx,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "none",
    });

    // Fast steer should NOT be attempted because threads don't match
    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();

    // Instead, the message should be enqueued to preserve routing
    expect(enqueueFollowupRunMock).toHaveBeenCalledWith(
      "main",
      expect.objectContaining({ originatingThreadId: "1706742543.891709" }),
      expect.anything(),
    );
  });

  it("allows fast steer when both active run and incoming message have no thread", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();
    getActiveRunThreadContextMock.mockClear();

    // Active run has no thread context
    getActiveRunThreadContextMock.mockReturnValue(undefined);
    // Steer succeeds
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "slack",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Message also has no thread ID - threads match (both undefined)
    const followupRun = createFollowupRun({
      originatingThreadId: undefined,
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "steer" } as QueueSettings,
      shouldSteer: true,
      shouldFollowup: false,
      isActive: true,
      isStreaming: true,
      typing,
      sessionCtx,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "none",
    });

    // Fast steer SHOULD be attempted
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith("session", "hello");

    // Should NOT fall through to enqueue
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("skips fast steer for numeric thread ID when active run has no thread", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();
    getActiveRunThreadContextMock.mockClear();

    // Active run has no thread context
    getActiveRunThreadContextMock.mockReturnValue(undefined);
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingTo: "chat:123",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Telegram topic ID is numeric - doesn't match undefined
    const followupRun = createFollowupRun({
      originatingThreadId: 12345,
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "steer" } as QueueSettings,
      shouldSteer: true,
      shouldFollowup: false,
      isActive: true,
      isStreaming: true,
      typing,
      sessionCtx,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "none",
    });

    // Should NOT fast steer - threads don't match
    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalled();
  });

  it("allows fast steer when incoming message is from the same thread as active run", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();
    getActiveRunThreadContextMock.mockClear();

    const threadId = "1706742543.891709";

    // Active run is in the same thread as incoming message
    getActiveRunThreadContextMock.mockReturnValue(threadId);
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "slack",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Message from the SAME thread as the active run
    const followupRun = createFollowupRun({
      originatingThreadId: threadId,
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "steer" } as QueueSettings,
      shouldSteer: true,
      shouldFollowup: false,
      isActive: true,
      isStreaming: true,
      typing,
      sessionCtx,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "none",
    });

    // Fast steer SHOULD be attempted because threads match
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith("session", "hello");

    // Should NOT fall through to enqueue
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });
});

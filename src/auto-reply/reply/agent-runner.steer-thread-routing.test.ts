import { describe, expect, it, vi } from "vitest";

import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const queueEmbeddedPiMessageMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

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
  it("skips fast steer when message has originatingThreadId to preserve routing", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();

    // Steer would succeed if attempted
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "slack",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Message has a thread ID - should NOT use fast steer
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

    // Fast steer should NOT be attempted because originatingThreadId is set
    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();

    // Instead, the message should be enqueued to preserve routing
    expect(enqueueFollowupRunMock).toHaveBeenCalledWith(
      "main",
      expect.objectContaining({ originatingThreadId: "1706742543.891709" }),
      expect.anything(),
    );
  });

  it("allows fast steer when message has no originatingThreadId", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();

    // Steer succeeds
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "slack",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Message has NO thread ID - can use fast steer
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

  it("handles numeric originatingThreadId (Telegram topic ID)", async () => {
    queueEmbeddedPiMessageMock.mockClear();
    enqueueFollowupRunMock.mockClear();
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingTo: "chat:123",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;

    // Telegram topic ID is numeric
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

    // Should NOT fast steer - numeric thread ID still needs routing preserved
    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalled();
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const queueEmbeddedPiMessageMock = vi.fn<(sessionId: string, text: string) => boolean>(() => false);
const enqueueFollowupRunMock = vi.fn<typeof import("./queue.js").enqueueFollowupRun>();

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  queueEmbeddedPiMessage: (sessionId: string, text: string) =>
    queueEmbeddedPiMessageMock(sessionId, text),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: (...args: Parameters<typeof import("./queue.js").enqueueFollowupRun>) =>
    enqueueFollowupRunMock(...args),
  refreshQueuedFollowupSession: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

function makeRunReplyAgentParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> = {},
): Parameters<typeof runReplyAgent>[0] {
  const prompt = "keep going";
  return {
    commandBody: prompt,
    followupRun: createMockFollowupRun({
      prompt,
      run: {
        sessionId: "session-active",
        sessionKey: "agent:main:main",
      },
    }) as unknown as FollowupRun,
    queueKey: "agent:main:main",
    resolvedQueue: { mode: "steer" } as QueueSettings,
    shouldSteer: true,
    shouldFollowup: false,
    isActive: true,
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
    ...overrides,
  };
}

describe("runReplyAgent steer guard", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  beforeEach(() => {
    queueEmbeddedPiMessageMock.mockReset();
    queueEmbeddedPiMessageMock.mockReturnValue(false);
    enqueueFollowupRunMock.mockReset();
  });

  it("attempts steer injection for active non-streaming runs", async () => {
    queueEmbeddedPiMessageMock.mockReturnValue(true);
    const typing = createMockTypingController();

    const result = await runReplyAgent(makeRunReplyAgentParams({ typing }));

    expect(result).toBeUndefined();
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith("session-active", "keep going");
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });
});

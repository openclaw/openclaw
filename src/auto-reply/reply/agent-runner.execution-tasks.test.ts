import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const listSubagentRunsForRequesterMock = vi.fn();

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
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: (...args: unknown[]) => listSubagentRunsForRequesterMock(...args),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

beforeEach(() => {
  runEmbeddedPiAgentMock.mockReset();
  listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
});

function createRun() {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "webchat",
    OriginatingTo: "session:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "webchat",
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
  } as unknown as FollowupRun;

  return runReplyAgent({
    commandBody: "请继续执行这个任务",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    sessionKey: "main",
    defaultModel: "anthropic/claude-opus-4-5",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent execution-task interim retry", () => {
  it("reruns once when the first turn only returns an acknowledgement", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "on it" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "已经完成，结果如下。" }],
        meta: {},
      });

    const result = await createRun();

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]).toMatchObject({
      prompt: expect.stringContaining(
        "Your previous response was only an acknowledgement and did not complete the user's task.",
      ),
    });
    expect(result).toMatchObject({ text: "已经完成，结果如下。" });
  });

  it("does not rerun when a subagent run is already active", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([
      {
        runId: "child-1",
        childSessionKey: "agent:main:child",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        task: "background task",
        cleanup: "keep",
        createdAt: Date.now(),
      },
    ]);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "on it" }],
      meta: {},
    });

    const result = await createRun();

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: "on it" });
  });

  it("does not rerun when the first turn already returns substantive content", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "这是最终结果，不需要后台续跑。" }],
      meta: {},
    });

    const result = await createRun();

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: "这是最终结果，不需要后台续跑。" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const listSubagentRunsForRequesterMock = vi.fn();
const spawnSubagentRunMock = vi.fn();

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

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentRun: (...args: unknown[]) => spawnSubagentRunMock(...args),
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
  spawnSubagentRunMock.mockReset();
});

function createRun(overrides?: {
  commandBody?: string;
  summaryLine?: string;
  sessionKey?: string;
}) {
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
    summaryLine: overrides?.summaryLine ?? "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: overrides?.sessionKey ?? "main",
      agentId: "main",
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
    commandBody: overrides?.commandBody ?? "Please continue executing this task.",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    sessionKey: overrides?.sessionKey ?? "main",
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
        payloads: [{ text: "Done. Here is the concrete result." }],
        meta: {},
      });

    const result = await createRun();

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]).toMatchObject({
      prompt: expect.stringContaining(
        "Your previous response was only an acknowledgement and did not complete the user's task.",
      ),
    });
    expect(result).toMatchObject({ text: "Done. Here is the concrete result." });
  });

  it("normalizes interim acknowledgements when a background executor is already active", async () => {
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
    expect(result).toMatchObject({
      text: "On it. A background run is already in progress and will report back when it is done.",
    });
  });

  it("short-circuits bare continuation nudges when a background executor is already active", async () => {
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

    const result = await createRun({
      summaryLine: "继续执行",
      commandBody: "继续执行",
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "On it. A background run is already in progress and will report back when it is done.",
    });
  });

  it("falls back to commandBody when summaryLine is empty during continuation short-circuit", async () => {
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

    const result = await createRun({
      summaryLine: "",
      commandBody: "继续执行",
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "On it. A background run is already in progress and will report back when it is done.",
    });
  });

  it("still evaluates non-trivial follow-up instructions while a background executor is active", async () => {
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

    const result = await createRun({
      summaryLine: "继续执行，但把标题改短一点",
      commandBody: "继续执行，但把标题改短一点",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "On it. A background run is already in progress and will report back when it is done.",
    });
  });

  it("does not rerun when the first turn already returns substantive content", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Here is the final result. No background run is needed." }],
      meta: {},
    });

    const result = await createRun();

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "Here is the final result. No background run is needed.",
    });
  });

  it("auto-spawns a background executor when continuation still only acknowledges", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "on it" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "我先把这张结果图取出来并看一眼，看完后我再只回复你我的判断。" }],
        meta: {},
      });
    spawnSubagentRunMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:main:subagent:test",
      runId: "child-run-1",
    });

    const result = await createRun({
      summaryLine: "Review the latest Gemini image and keep iterating until it is usable",
      commandBody: "Please continue executing this task.",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(spawnSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining(
          "Recover the current user goal from the requester session and continue executing it in the background.",
        ),
        requesterSessionKey: "main",
        requesterAgentIdOverride: "main",
        label: "Review the latest Gemini image and keep iterating until it is usable",
      }),
    );
    expect(spawnSubagentRunMock.mock.calls[0]?.[0]).toMatchObject({
      task: expect.stringContaining(
        "Requester session: main. Read it with sessions_history before acting whenever the latest message is ambiguous or just asks to continue.",
      ),
    });
    expect(spawnSubagentRunMock.mock.calls[0]?.[0]).toMatchObject({
      task: expect.stringContaining(
        "The requester session only produced this interim acknowledgement before handoff: 我先把这张结果图取出来并看一眼，看完后我再只回复你我的判断。",
      ),
    });
    expect(result).toMatchObject({
      text: "On it. I started a background run and will report back when it is done.",
    });
  });

  it("returns a concrete blocker when the background executor cannot start", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "on it" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "我先把这张结果图取出来并看一眼，看完后我再只回复你我的判断。" }],
        meta: {},
      });
    spawnSubagentRunMock.mockResolvedValueOnce({
      status: "error",
      error: "gateway unavailable",
    });

    const result = await createRun();

    expect(result).toMatchObject({
      isError: true,
      text: expect.stringContaining("Reason: gateway unavailable."),
    });
  });

  it("redacts internal spawn errors from the user-facing blocker reply", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "on it" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "我先把这张结果图取出来并看一眼，看完后我再只回复你我的判断。" }],
        meta: {},
      });
    spawnSubagentRunMock.mockResolvedValueOnce({
      status: "error",
      error: "HTTP 500 at https://example.com/internal/token from C:\\temp\\trace.log",
    });

    const result = await createRun();

    expect(result).toMatchObject({
      isError: true,
      text: "I could not keep the executor running in the background because starting the follow-up run failed. Please retry the task.",
    });
  });

  it("turns repeated subagent acknowledgements into a concrete blocker instead of nesting", async () => {
    listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "on it" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "我先把这张结果图取出来并看一眼，看完后我再只回复你我的判断。" }],
        meta: {},
      });

    const result = await createRun({
      sessionKey: "agent:main:subagent:child-1",
    });

    expect(spawnSubagentRunMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      text: expect.stringContaining(
        "The background executor stopped after repeated acknowledgements without concrete progress.",
      ),
    });
  });
});

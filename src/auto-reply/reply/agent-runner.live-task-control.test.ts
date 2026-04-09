import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "../../process/command-queue.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import type { TemplateContext } from "../templating.js";
import {
  beginForegroundLiveTaskFlow,
  createQueuedLiveTaskFlow,
  formatLiveTaskHandle,
  resolveLiveTaskBoard,
} from "./live-task-control.js";
import { enqueueFollowupRun, type QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const enqueueFollowupRunMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const scheduleFollowupDrainMock = vi.fn();
const loadCronStoreMock = vi.fn();

function createCliBackendTestConfig() {
  return {
    agents: {
      defaults: {},
    },
  };
}

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
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(),
  isEmbeddedPiRunActive: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  resolveActiveEmbeddedRunSessionId: vi.fn(() => undefined),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
    refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
    scheduleFollowupDrain: (...args: unknown[]) => scheduleFollowupDrainMock(...args),
  };
});

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

describe("runReplyAgent live task controller", () => {
  beforeEach(() => {
    resetCommandQueueStateForTest();
    resetTaskFlowRegistryForTests();
    resetTaskRegistryForTests();
    enqueueFollowupRunMock.mockReset();
    enqueueFollowupRunMock.mockReturnValue(true);
    refreshQueuedFollowupSessionMock.mockReset();
    scheduleFollowupDrainMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    loadCronStoreMock.mockReset();
    loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
    runWithModelFallbackMock.mockImplementation(
      async ({ provider, model, run }: RunWithModelFallbackParams) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
    resetTaskFlowRegistryForTests();
    resetTaskRegistryForTests();
    vi.useRealTimers();
  });

  function createLiveTaskControllerRun(params: {
    commandBody: string;
    isActive?: boolean;
    shouldFollowup?: boolean;
    isRunActive?: () => boolean;
    queueMode?: QueueSettings["mode"];
  }) {
    const typing = createMockTypingController();
    const followupRun = createMockFollowupRun({
      prompt: params.commandBody,
      summaryLine: params.commandBody,
      originatingChannel: "telegram",
      originatingChatType: "private",
      originatingTo: "chat-1",
      run: {
        agentId: "main",
        sessionId: "session",
        sessionKey: "agent:main:main",
        messageProvider: "telegram",
        senderId: "telegram:owner",
        ownerNumbers: ["telegram:owner"],
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: createCliBackendTestConfig(),
        provider: "anthropic",
        model: "claude",
      },
    });
    const sessionCtx = {
      Provider: "telegram",
      Surface: "telegram",
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
      ChatType: "private",
    } as unknown as TemplateContext;

    return {
      run: () =>
        runReplyAgent({
          commandBody: params.commandBody,
          followupRun,
          queueKey: "agent:main:main",
          resolvedQueue: { mode: params.queueMode ?? "collect" } as QueueSettings,
          shouldSteer: false,
          shouldFollowup: params.shouldFollowup ?? true,
          isActive: params.isActive ?? false,
          isRunActive: params.isRunActive,
          isStreaming: false,
          typing,
          sessionCtx,
          defaultModel: "anthropic/claude",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "message_end",
          shouldInjectGroupIntro: false,
          typingMode: "instant",
        }),
    };
  }

  it("promotes an explicit continue handle instead of treating it as a no-op", async () => {
    const running = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "auto-reply/live-task-control",
      goal: "Keep working on the foreground thread",
      status: "running",
      currentStep: "Working in the foreground conversation.",
      stateJson: {
        controller: {
          foreground: true,
          browserLease: true,
        },
        request: {
          prompt: "keep working on the foreground thread",
          summaryLine: "keep working on the foreground thread",
          waitKind: "browser_lease",
        },
      },
    });
    const target = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "auto-reply/live-task-control",
      goal: "Review the target thread",
      status: "running",
      currentStep: "Working in the foreground conversation.",
      stateJson: {
        controller: {
          foreground: false,
          browserLease: false,
        },
        request: {
          prompt: "review the target thread",
          summaryLine: "review the target thread",
          waitKind: "capacity",
        },
      },
    });

    const { run } = createLiveTaskControllerRun({
      commandBody: `continue ${formatLiveTaskHandle(target)}`,
    });
    const result = await run();
    const board = resolveLiveTaskBoard("agent:main:main");

    expect(result).toMatchObject({
      text: expect.stringContaining("is now the foreground flow"),
    });
    expect(board.foreground?.flowId).toBe(target.flowId);
    expect(board.browserHolder?.flowId).toBe(running.flowId);
  });

  it("returns a did-not-queue reply when the controller enqueue is deduped", async () => {
    vi.mocked(enqueueFollowupRun).mockReturnValue(false);

    const { run } = createLiveTaskControllerRun({
      commandBody: "draft the next replies now",
      isActive: true,
      shouldFollowup: true,
      queueMode: "collect",
    });
    const result = await run();

    expect(result).toMatchObject({
      text: expect.stringContaining("Did not queue flow"),
    });
    expect((result as { text?: string } | undefined)?.text).not.toContain("Queued as flow");
  });

  it("dispatches Telegram DM work to the background even when no run is active", async () => {
    const { run } = createLiveTaskControllerRun({
      commandBody: "draft the next replies now",
      isActive: false,
      shouldFollowup: false,
      isRunActive: () => true,
      queueMode: "collect",
    });

    const result = await run();
    const board = resolveLiveTaskBoard("agent:main:main");

    expect(result).toMatchObject({
      text: expect.stringContaining("in the background as"),
    });
    expect((result as { text?: string } | undefined)?.text).not.toContain("is now running");
    expect(board.foreground).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
  });

  it("answers queue summary questions inline instead of creating a new flow", async () => {
    beginForegroundLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createMockFollowupRun({
        prompt: "reply while the browser is warm",
        summaryLine: "reply while the browser is warm",
        originatingChannel: "telegram",
        originatingChatType: "private",
        run: {
          sessionKey: "agent:main:main",
          messageProvider: "telegram",
        },
      }),
    });
    const existingCount = resolveLiveTaskBoard("agent:main:main").all.length;

    const { run } = createLiveTaskControllerRun({
      commandBody: "What are all the 3 queues?",
      isActive: true,
      shouldFollowup: false,
      isRunActive: () => true,
      queueMode: "collect",
    });
    const result = await run();
    const board = resolveLiveTaskBoard("agent:main:main");

    expect(result).toMatchObject({
      text: expect.stringContaining("📋 Tasks"),
    });
    expect(board.all).toHaveLength(existingCount);
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("cancels queued work from Telegram without spawning another queued flow", async () => {
    const foreground = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "auto-reply/live-task-control",
      goal: "Keep replying in the foreground",
      status: "running",
      currentStep: "Working in the foreground conversation.",
      stateJson: {
        controller: {
          foreground: true,
          browserLease: true,
        },
        request: {
          prompt: "Keep replying in the foreground",
          summaryLine: "Keep replying in the foreground",
          waitKind: "browser_lease",
        },
      },
    });
    const waiting = createQueuedLiveTaskFlow({
      queueKey: "agent:main:main",
      followupRun: createMockFollowupRun({
        prompt: "draft the next batch",
        summaryLine: "draft the next batch",
        originatingChannel: "telegram",
        originatingChatType: "private",
        run: {
          sessionKey: "agent:main:main",
          messageProvider: "telegram",
        },
      }),
    });
    const blocked = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "auto-reply/live-task-control",
      goal: "Need confirmation",
      status: "blocked",
      blockedSummary: "Waiting for confirmation.",
      stateJson: {
        controller: {
          foreground: false,
          browserLease: false,
        },
        request: {
          prompt: "Need confirmation",
          summaryLine: "Need confirmation",
          waitKind: "capacity",
        },
      },
    });

    const { run } = createLiveTaskControllerRun({
      commandBody: "Kill all 3 queues",
      isActive: true,
      shouldFollowup: false,
      isRunActive: () => true,
      queueMode: "collect",
    });
    const result = await run();
    const board = resolveLiveTaskBoard("agent:main:main");

    expect(result).toMatchObject({
      text: expect.stringContaining("Kept foreground flow"),
    });
    expect((result as { text?: string } | undefined)?.text).toContain(
      formatLiveTaskHandle(foreground),
    );
    expect(board.foreground?.flowId).toBe(foreground.flowId);
    expect(board.all.find((flow) => flow.flowId === waiting.flowId)?.status).toBe("cancelled");
    expect(board.all.find((flow) => flow.flowId === blocked.flowId)?.status).toBe("cancelled");
    expect(
      board.all.filter((flow) => flow.status === "waiting" || flow.status === "blocked"),
    ).toHaveLength(0);
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });
});

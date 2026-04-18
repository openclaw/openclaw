/**
 * Tests for the steer guard in runReplyAgent — verifies that steer mode
 * message injection uses `isActive` (not `isStreaming`) to decide whether
 * to inject a steer message into an already-running agent session.
 *
 * Covers the fix for issue #48003 / PR #52351.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const queueEmbeddedPiMessageMock = vi.fn();

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: vi.fn().mockReturnValue([]),
  refreshOAuthApiKey: vi.fn(),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded-runner/runs.js")>(
    "../../agents/pi-embedded-runner/runs.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: (...args: unknown[]) => queueEmbeddedPiMessageMock(...args),
  };
});

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  };
});

vi.mock("../../agents/cli-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/cli-runner.js")>(
    "../../agents/cli-runner.js",
  );
  return {
    ...actual,
    runCliAgent: (params: unknown) => runCliAgentMock(params),
  };
});

vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../cron/store.js")>("../../cron/store.js");
  return {
    ...actual,
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  };
});

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

beforeEach(() => {
  runEmbeddedPiAgentMock.mockClear();
  runCliAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  queueEmbeddedPiMessageMock.mockClear();
  loadCronStoreMock.mockClear();
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
  vi.useRealTimers();
});

describe("runReplyAgent steer mode message injection", () => {
  function createSteerRun(params: {
    shouldSteer: boolean;
    isActive: boolean;
    shouldFollowup?: boolean;
    queueEmbeddedResult?: boolean;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "webchat",
      OriginatingTo: "session:steer",
      AccountId: "primary",
      MessageSid: "msg-steer",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "steer" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "steer this",
      summaryLine: "steer this",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session-steer",
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
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    queueEmbeddedPiMessageMock.mockReturnValue(params.queueEmbeddedResult ?? false);

    return {
      promise: runReplyAgent({
        commandBody: "steer this",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: params.shouldSteer,
        shouldFollowup: params.shouldFollowup ?? false,
        isActive: params.isActive,

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
      typing,
    };
  }

  it("injects steer message when shouldSteer=true AND isActive=true", async () => {
    const { promise, typing } = createSteerRun({
      shouldSteer: true,
      isActive: true,
      queueEmbeddedResult: true,
    });

    const result = await promise;

    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith("session-steer", "steer this");
    // When steered successfully and shouldFollowup=false, returns undefined (early exit).
    expect(result).toBeUndefined();
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("does NOT inject steer message when shouldSteer=true AND isActive=false", async () => {
    // When isActive is false, the steer guard is skipped entirely and the
    // agent proceeds to a full run.
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const { promise } = createSteerRun({
      shouldSteer: true,
      isActive: false,
    });

    const result = await promise;

    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("does NOT inject steer message when shouldSteer=false", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const { promise } = createSteerRun({
      shouldSteer: false,
      isActive: true,
    });

    await promise;

    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();
  });
});

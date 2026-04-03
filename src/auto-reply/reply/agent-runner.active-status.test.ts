import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { logTurnLatencyStage, resetDiagnosticStateForTest } from "../../logging/diagnostic.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
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

const { runReplyAgent } = await import("./agent-runner.js");

beforeEach(() => {
  runEmbeddedPiAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  loadCronStoreMock.mockReset();
  resetSystemEventsForTest();
  resetDiagnosticStateForTest();
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  runWithModelFallbackMock.mockImplementation(
    async ({
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
  );
});

afterEach(() => {
  resetSystemEventsForTest();
  resetDiagnosticStateForTest();
});

function seedVisibleSilenceLatencyPattern() {
  logTurnLatencyStage({
    turnLatencyId: "turn-policy",
    stage: "queue_arbitrated",
    channel: "whatsapp",
    sessionKey: "main",
    durationMs: 100,
  });
  logTurnLatencyStage({
    turnLatencyId: "turn-policy",
    stage: "run_started",
    channel: "whatsapp",
    sessionKey: "main",
    durationMs: 250,
  });
  logTurnLatencyStage({
    turnLatencyId: "turn-policy",
    stage: "first_visible_emitted",
    channel: "whatsapp",
    sessionKey: "main",
    durationMs: 1_150,
    firstVisibleKind: "status",
  });
  logTurnLatencyStage({
    turnLatencyId: "turn-policy",
    stage: "completed",
    channel: "whatsapp",
    sessionKey: "main",
    durationMs: 1_350,
  });
}

async function runActiveStatusCase(queueMode: QueueSettings["mode"]) {
  seedVisibleSilenceLatencyPattern();
  runEmbeddedPiAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "ok" }],
    meta: {},
  });
  const onStatusReply = vi.fn(async () => true);
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg",
    Surface: "whatsapp",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: queueMode } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
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

  await runReplyAgent({
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: queueMode === "steer",
    shouldFollowup: queueMode === "followup",
    isActive: true,
    isStreaming: true,
    opts: { onStatusReply },
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });

  return onStatusReply;
}

describe("runReplyAgent active-run supplement status", () => {
  it("emits early status for collect when phase-2 supplement policy is prioritized", async () => {
    const onStatusReply = await runActiveStatusCase("collect");

    expect(onStatusReply).toHaveBeenCalledWith({
      text: "我会把你刚补充的信息并入当前任务。",
    });
  });

  it("does not emit early status for steer even when visible silence dominates", async () => {
    const onStatusReply = await runActiveStatusCase("steer");

    expect(onStatusReply).not.toHaveBeenCalled();
  });
});

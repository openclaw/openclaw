import { expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

it("emits usage diagnostics for a deliberate silent reply", async () => {
  const sessionKey = "agent:main:silent-usage";
  const sessionId = "silent-usage-session";
  const cfg = {};
  const followupRun = createMockFollowupRun({
    prompt: "check quietly",
    run: {
      agentId: "main",
      agentDir: "agent",
      workspaceDir: "workspace",
      sessionKey,
      sessionId,
      config: cfg,
      provider: "openai",
      model: "gpt-5.6-luna",
    },
  });
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
  });
  replyOperation.setPhase("running");
  const diagnostics: DiagnosticEventPayload[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => diagnostics.push(event));
  const context: FinalizeReplyAgentRunInput = {
    activeIsNewSession: false,
    activeSessionEntry: undefined,
    activeSessionStore: {},
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    cfg,
    commandBody: followupRun.prompt,
    defaultModel: "gpt-5.6-luna",
    followupRun,
    isHeartbeat: true,
    pendingToolTasks: new Set(),
    preflightCompactionApplied: false,
    queueKey: sessionKey,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    replyOperation,
    replyRouteThreadId: undefined,
    replyToChannel: undefined,
    replyToMode: "off",
    resolvedBlockStreamingBreak: "message_end",
    resolvedQueue: { mode: "followup" },
    resolvedVerboseLevel: "off",
    returnWithQueuedFollowupDrain: (value) => value,
    runFollowupTurn: async () => {},
    execution: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: [{ text: SILENT_REPLY_TOKEN }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.6-luna",
            usage: { input: 1_200, output: 25, total: 1_225 },
          },
        },
      },
      resolved: { provider: "openai", model: "gpt-5.6-luna" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
    runId: "silent-usage-run",
    runStartedAt: Date.now(),
    sessionCtx: {},
    sessionKey,
    shouldInjectGroupIntro: false,
    storePath: undefined,
    typingSignals: createTypingSignaler({
      typing: createMockTypingController(),
      mode: "never",
      isHeartbeat: true,
    }),
  };

  try {
    expect(await finalizeReplyAgentRun(context)).toBeUndefined();
    expect(diagnostics.find((event) => event.type === "model.usage")).toMatchObject({
      type: "model.usage",
      usage: { input: 1_200, output: 25, total: 1_225 },
    });
  } finally {
    unsubscribe();
    replyOperation.complete();
  }
});

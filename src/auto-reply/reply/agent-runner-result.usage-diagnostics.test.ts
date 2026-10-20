import { expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createTestFinalizationContext } from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

it("emits usage diagnostics for a deliberate silent reply", async () => {
  const sessionKey = "agent:main:silent-usage";
  const sessionId = "silent-usage-session";
  const followupRun = createMockFollowupRun({
    prompt: "check quietly",
    run: {
      sessionKey,
      sessionId,
      provider: "openai",
      model: "gpt-5.6-luna",
    },
  });
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: "/synthetic/usage-diagnostics",
      sessionKey,
      incarnation: sessionId,
      agentId: "main",
    }),
  });
  replyOperation.setPhase("running");
  const diagnostics: DiagnosticEventPayload[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => diagnostics.push(event));
  const context = createTestFinalizationContext(followupRun, replyOperation);
  context.isHeartbeat = true;
  context.runId = "silent-usage-run";
  context.typingSignals = createTypingSignaler({
    typing: createMockTypingController(),
    mode: "never",
    isHeartbeat: true,
  });
  context.execution.result = {
    payloads: [],
    meta: {
      durationMs: 1,
      terminalReply: { disposition: "silent" },
      agentMeta: {
        sessionId,
        ...context.execution.resolved,
        usage: { input: 1_200, output: 25, total: 1_225 },
      },
    },
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

import { expect, it, onTestFinished, vi } from "vitest";
import { runAgentLoop } from "../../../packages/agent-core/src/agent-loop.js";
import {
  config,
  makeAssistantMessage,
  reply,
  user,
} from "../../../packages/agent-core/src/agent-loop.test-support.js";
import { REPEATED_TOOL_ERROR_CODE } from "../../../packages/agent-core/src/errors.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import { resolveIncompleteTurnPayloadText } from "../embedded-agent-runner/run/incomplete-turn-resolution.js";
import { createToolLoopBatchAdmission } from "../embedded-agent-runner/run/tool-loop-recovery.js";
import { createSubscribedSessionHarness } from "../embedded-agent-subscribe.e2e-harness.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createHeartbeatResponseTool } from "./heartbeat-response-tool.js";

it.each(["accepted", "invalid response", "invalid schema"])(
  "ends a repeating heartbeat model without timing out (%s)",
  async (scenario) => {
    const invalid = scenario !== "accepted";
    const tool = createHeartbeatResponseTool();
    const budget = new AbortController();
    const outcomes: ReturnType<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "heartbeat-loop",
      sessionPersistence: "detached",
      onAgentEvent: (event) => {
        const phase = event.data.phase;
        if (event.stream === "lifecycle" && (phase === "end" || phase === "error")) {
          outcomes.push(
            buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data }),
          );
        }
      },
    });
    onTestFinished(() => subscription.unsubscribe());
    let requests = 0;
    const stream = vi.fn(() => {
      requests += 1;
      // Bound a broken implementation without waiting for a real run-budget timeout.
      if (requests > 6) {
        budget.abort(new Error("Synthetic run budget exhausted"));
      }
      return reply(
        makeAssistantMessage([
          {
            type: "toolCall",
            id: `heartbeat-${requests}`,
            name: tool.name,
            arguments: {
              outcome: scenario === "invalid schema" ? `invalid-${requests}` : "no_change",
              notify: requests % 2 === 0,
              summary:
                scenario === "invalid response"
                  ? " ".repeat(requests)
                  : `Quiet heartbeat, wording ${requests}.`,
            },
          },
        ]),
      );
    });
    const messages = await runAgentLoop(
      [user("Report the heartbeat outcome.")],
      { systemPrompt: "", messages: [], tools: [tool] },
      { ...config, beforeToolBatch: createToolLoopBatchAdmission({}) },
      emit,
      budget.signal,
      stream,
    );
    await subscription.waitForPendingEvents();

    expect(stream).toHaveBeenCalledTimes(invalid ? 3 : 1);
    expect(budget.signal.aborted).toBe(false);
    if (!invalid) {
      expect(subscription.getHeartbeatToolResponse()).toMatchObject({
        outcome: "no_change",
        notify: false,
        summary: "Quiet heartbeat, wording 1.",
      });
    }
    expect(outcomes).toEqual([expect.objectContaining({ status: invalid ? "error" : "ok" })]);
    if (invalid) {
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorCode: REPEATED_TOOL_ERROR_CODE,
      });
      expect(subscription.getHeartbeatToolResponse()).toBeUndefined();
    } else {
      expect(messages.at(-1)).toMatchObject({
        role: "toolResult",
        isError: false,
        details: { status: "accepted" },
      });
      expect(
        resolveIncompleteTurnPayloadText({
          payloadCount: 0,
          aborted: false,
          externalAbort: false,
          timedOut: false,
          attempt: makeEmbeddedRunnerAttempt({
            currentAttemptAssistant: messages.findLast((message) => message.role === "assistant"),
            heartbeatToolResponse: subscription.getHeartbeatToolResponse(),
          }),
        }),
      ).toBeNull();
    }
  },
);

import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../packages/agent-core/src/agent.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { Message, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  buildAdjustedParamsKey,
  peekAdjustedParamsForToolCall,
  preExecutionBlockedToolCallIds,
  recordAdjustedParamsForToolCall,
  recordToolExecutionStarted,
  recordToolExecutionTracked,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { inferToolMetaFromArgsCore } from "./tool-display.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

const steeringModel: Model = {
  id: "tool-terminal-steering-model",
  name: "Tool terminal steering model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

function responseStream(content: Parameters<typeof makeAgentAssistantMessage>[0]["content"]) {
  const message = makeAgentAssistantMessage({
    content,
    stopReason: content?.length ? "toolUse" : "stop",
  });
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  stream.end();
  return stream;
}

const makeToolCall = (id: string, name = "exec", args = {}) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
});

type Observation = Parameters<ReturnType<typeof createToolTerminalObserver>>[0];
function failed(
  toolName: string,
  error: string,
  fields: Omit<Observation, "toolName" | "outcome" | "failure"> = {},
): Observation {
  return { ...fields, toolName, outcome: "failure", failure: { error } };
}

describe("tool terminal outcome observer", () => {
  afterEach(() => resetAdjustedParamsByToolCallIdForTests());

  it.each([
    {
      rejection: "invalid arguments",
      blocked: false,
      expected: "⚠️ Browser failed: invalid arguments",
    },
    { rejection: "policy denial", blocked: true, expected: "⚠️ Browser blocked" },
  ])(
    "describes $rejection through the agent subscription and final reply",
    async ({ blocked, expected }) => {
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "validation-warning",
      });
      let requests = 0;
      const agent = new Agent({
        initialState: {
          model: steeringModel,
          tools: [
            {
              name: "browser",
              label: "browser",
              description: "Opens a target.",
              parameters: Type.Object({ target: Type.String() }),
              execute,
            },
          ],
        },
        streamFn: () => {
          const first = requests++ === 0;
          return responseStream(
            first
              ? [
                  makeToolCall(
                    "call-validation",
                    "browser",
                    blocked ? { target: "PRIVATE_TARGET" } : { query: "PRIVATE_ARGUMENT" },
                  ),
                ]
              : [],
          );
        },
        beforeToolCall: async () =>
          blocked ? { block: true, reason: "PRIVATE_POLICY_REASON" } : undefined,
      });
      const unsubscribe = agent.subscribe(emit);
      try {
        await agent.prompt("Open the target.");
        await subscription.waitForPendingEvents();
        expect(execute).not.toHaveBeenCalled();
        const payloads = buildPayloads({
          assistantTexts: subscription.assistantTexts,
          lastAssistant: subscription.getCurrentAttemptAssistant(),
          lastToolError: subscription.getLastToolError(),
        });
        expect(payloads).toEqual([expect.objectContaining({ text: expected, isError: true })]);
        expect(JSON.stringify(payloads)).not.toContain("PRIVATE_");
      } finally {
        unsubscribe();
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { firstOutcome: "success", error: undefined, warnings: [] },
    { firstOutcome: "failure", error: "Original tool failure", warnings: ["⚠️ Exec failed"] },
    { firstOutcome: "blocked", error: "Original admission failure", warnings: ["⚠️ Exec blocked"] },
  ])(
    "classifies a steering skip after $firstOutcome through the registered subscription",
    async ({ firstOutcome, error, warnings }) => {
      const firstSettled = createDeferred();
      const releaseFirst = createDeferred();
      const execute = vi.fn(async () => {
        if (firstOutcome === "failure") {
          throw new Error("Original tool failure");
        }
        return { content: [{ type: "text" as const, text: "first completed" }], details: {} };
      });
      const providerRequests: Message[][] = [];
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "steering-warning" });
      const agent = new Agent({
        initialState: {
          model: steeringModel,
          tools: [
            {
              name: "exec",
              label: "exec",
              description: "Runs a step.",
              parameters: Type.Object({}),
              execute,
            },
          ],
        },
        streamFn: (_model, context) => {
          providerRequests.push(context.messages.slice());
          return responseStream(
            providerRequests.length === 1
              ? [
                  // A blocked call does not start the plan, so an executed call precedes it.
                  ...(firstOutcome === "blocked" ? [makeToolCall("call-started")] : []),
                  makeToolCall("call-first"),
                  makeToolCall("call-second"),
                ]
              : [],
          );
        },
        toolExecution: "sequential",
        beforeToolCall: async ({ toolCall }) =>
          firstOutcome === "blocked" && toolCall.id === "call-first"
            ? { block: true, reason: "Original admission failure" }
            : undefined,
        afterToolOutcome: async ({ toolCall }) => {
          if (toolCall.id === "call-first") {
            firstSettled.resolve();
            await releaseFirst.promise;
          }
        },
      });
      const unsubscribe = agent.subscribe(emit);
      const run = agent.prompt("start the sequence");
      try {
        await firstSettled.promise;
        agent.steer({ role: "user", content: "change direction", timestamp: 1 });
        releaseFirst.resolve();
        await run;
        await subscription.waitForPendingEvents();

        expect(execute).toHaveBeenCalledTimes(1);
        expect(providerRequests).toHaveLength(2);
        expect(providerRequests[1]?.slice(-2)).toMatchObject([
          {
            role: "toolResult",
            toolCallId: "call-second",
            isError: true,
            details: { status: "skipped", deniedReason: "steering" },
          },
          { role: "user", content: "change direction" },
        ]);
        const lastToolError = subscription.getLastToolError();
        expect(lastToolError?.error).toBe(error);
        expect(
          buildPayloads({
            assistantTexts: subscription.assistantTexts,
            lastAssistant: subscription.getCurrentAttemptAssistant(),
            lastToolError,
          }).map((payload) => payload.text),
        ).toEqual(warnings);
      } finally {
        releaseFirst.resolve();
        await run;
        unsubscribe();
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    {
      name: "admission failure",
      executionStarted: false,
      details: { status: "blocked", deniedReason: "tool-admission" },
    },
    {
      name: "other skipped work",
      executionStarted: false,
      details: { status: "skipped", deniedReason: "policy" },
    },
    {
      name: "executed steering-lookalike result",
      executionStarted: true,
      details: { status: "skipped", deniedReason: "steering" },
    },
  ])("keeps $name as a failure", ({ executionStarted, details }) => {
    const terminal = createToolTerminalObserver("run-non-steering-failure")({
      toolName: "exec",
      executionStarted,
      outcome: "failure",
      result: { details },
      failure: { error: "Original failure" },
    });
    expect(terminal.lastToolError).toMatchObject({ error: "Original failure", executionStarted });
    expect(
      buildPayloads({ lastToolError: terminal.lastToolError }).map((payload) => payload.text),
    ).toEqual([executionStarted ? "⚠️ Exec failed" : "⚠️ Exec blocked"]);
  });

  it("retains a genuine message failure across suppression until a real send succeeds", () => {
    const observe = createToolTerminalObserver("run-suppression");
    const suppression = {
      toolName: "message",
      arguments: { action: "send", target: "123", message: "omitted" },
      outcome: "success" as const,
      result: { details: { status: "suppressed", reason: "cancelled_by_message_sending_hook" } },
    };
    expect(observe(suppression).lastToolError).toBeUndefined();
    observe(
      failed("message", "Telegram transport failed", {
        arguments: { action: "send", target: "123", message: "failed" },
      }),
    );
    const afterSuppression = observe(suppression);
    expect(afterSuppression.lastToolError).toMatchObject({ error: "Telegram transport failed" });
    expect(buildPayloads({ lastToolError: afterSuppression.lastToolError })).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
    expect(
      observe({
        toolName: "message",
        arguments: { action: "send", target: "123", message: "delivered" },
        outcome: "success",
        result: { details: { ok: true, messageId: "sent-1" } },
      }).lastToolError,
    ).toBeUndefined();
  });

  it("keeps the latest failure when a different tool succeeds", () => {
    const observe = createToolTerminalObserver("run-1");
    observe(
      failed("message", "A failed", {
        arguments: { action: "send", to: "channel:a", message: "A" },
      }),
    );
    observe(
      failed("message", "B failed", {
        arguments: { action: "send", to: "channel:b", message: "B" },
      }),
    );
    const afterRead = observe({ toolName: "read", arguments: {}, outcome: "success" });

    expect(afterRead.lastToolError).toMatchObject({ error: "B failed" });
    const payloads = buildPayloads({ lastToolError: afterRead.lastToolError });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ isError: true });
  });

  it.each(["tracked", "started", "settled blocked"] as const)(
    "prefers %s host evidence to fallback execution facts",
    (mode) => {
      const runId = "run-host-evidence";
      const toolCallId = "call-host-evidence";
      const adjusted = { action: "send", to: "channel:adjusted" };
      if (mode === "settled blocked") {
        preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
      } else {
        (mode === "started" ? recordToolExecutionStarted : recordToolExecutionTracked)(
          toolCallId,
          runId,
        );
        recordAdjustedParamsForToolCall(toolCallId, adjusted, runId);
      }
      const started = mode === "started";
      const resolution = createToolTerminalObserver(runId)({
        toolCallId,
        toolName: "message",
        arguments: { action: "send", to: "channel:original" },
        ...(started ? {} : { executionStarted: true }),
        outcome: "failure",
        failure: { error: "execution failed", ...(started ? { executionStarted: false } : {}) },
      });
      expect(resolution).toMatchObject({
        executionStarted: started,
        sideEffectEvidence: started,
        lastToolError: { executionStarted: started, mutatingAction: started },
        ...(mode === "settled blocked" ? {} : { executedArguments: adjusted }),
      });
      if (mode !== "settled blocked") {
        expect(peekAdjustedParamsForToolCall(toolCallId, runId)).toEqual(adjusted);
      }
    },
  );

  it.each([
    ["message", "send", "failure", "uncertain", { executionStarted: false }],
    ["message", "read", "success", "read_completed", {}],
    ["message", "read", "failure", "failed_no_effect", {}],
    ["computer", "list_windows", "success", "read_completed", {}],
    ["computer", "get_cursor_position", "failure", "failed_no_effect", {}],
    ["plugin_read", undefined, "failure", "failed_no_effect", { replaySafe: true }],
    ["message", "send", "success", "mutation_committed", {}],
    ["plugin_unknown", undefined, "success", "uncertain", {}],
    ["message", "send", "failure", "uncertain", {}],
    ["memory_search", undefined, "success", "uncertain", {}],
    ["memory_get", undefined, "success", "read_completed", {}],
  ] as const)(
    "records a host-owned effect receipt for %s/%s/%s",
    (toolName, action, outcome, state, options) => {
      const input = {
        toolName,
        arguments: action ? { action } : {},
        outcome,
        ...(outcome === "failure" ? { failure: { error: "operation failed" } } : {}),
        ...options,
      };
      const terminal = createToolTerminalObserver("run-effect-receipt")(input);
      expect(terminal.effectReceipt).toEqual({ state });
      if (toolName === "memory_search" || toolName === "memory_get") {
        expect(terminal).toMatchObject({
          executionStarted: true,
          sideEffectEvidence: toolName === "memory_search",
        });
      }
    },
  );

  it("clears a failure after the same normalized tool succeeds", () => {
    const observe = createToolTerminalObserver("run-normalized-recovery");
    observe(failed(" Write ", "write failed"));
    expect(observe({ toolName: "WRITE", outcome: "success" }).lastToolError).toBeUndefined();
  });

  it("clears a failed sessions_spawn once a retry with adjusted arguments succeeds", () => {
    const observe = createToolTerminalObserver("run-spawn-retry");
    const failedArgs = {
      task: "Investigate the flaky gateway test",
      label: "Investigate",
      cwd: "/outside/workspace",
    };
    // The retry the model actually issues: drops the rejected cwd and rewords the task.
    const retryArgs = { task: "Investigate the flaky gateway test in repo scope" };

    observe(
      failed("sessions_spawn", "cwd is outside the workspace", {
        arguments: failedArgs,
        meta: inferToolMetaFromArgsCore("sessions_spawn", failedArgs),
      }),
    );
    const afterRetry = observe({
      toolName: "sessions_spawn",
      arguments: retryArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", retryArgs),
      outcome: "success",
    });

    expect(afterRetry.lastToolError).toBeUndefined();

    const payloads = buildPayloads({ lastToolError: afterRetry.lastToolError });
    expect(payloads).toEqual([]);
  });

  it.each([
    [true, 30_000, 2, "⚠️ Memory Search timed out after 30s; 2 partial results are available."],
    [true, 30_000, 1, "⚠️ Memory Search timed out after 30s; 1 partial result is available."],
    [true, 30_000, 0, "⚠️ Memory Search timed out after 30s."],
    [false, 30_000, 0, "⚠️ Memory Search failed"],
    [true, -1, 0, "⚠️ Memory Search failed"],
  ] as const)(
    "preserves timeout metadata (%s, %s ms, %s results) in the final warning",
    (timedOut, timeoutMs, count, expected) => {
      const terminal = createToolTerminalObserver("run-memory-timeout")({
        toolName: "memory_search",
        arguments: { query: "project notes" },
        outcome: "failure",
        result: {
          details: {
            timedOut,
            timeoutMs,
            partial: true,
            results: Array.from({ length: count }, (_, index) => ({ path: `memory/${index}.md` })),
            error: "memory_search timed out after 30s: PRIVATE_PROVIDER_DIAGNOSTIC",
          },
        },
        failure: { error: "memory_search timed out after 30s: PRIVATE_PROVIDER_DIAGNOSTIC" },
      });

      const payloads = buildPayloads({
        lastToolError: terminal.lastToolError,
        verboseLevel: "off",
      });
      expect(payloads).toEqual([expect.objectContaining({ text: expected, isError: true })]);
      expect(terminal.sideEffectEvidence).toBe(true);
    },
  );

  it("treats the assistant reply as authoritative after a failed persistence call", () => {
    const observation = failed("memory_store", "429 insufficient_quota", {
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      ownerMutation: { ownerKey: '["memory-lancedb","memory_store"]' },
    });
    const terminal = createToolTerminalObserver("run-memory-store")(observation);

    const payloads = buildPayloads({
      assistantTexts: ["I've saved that preference and will remember it."],
      lastToolError: terminal.lastToolError,
    });

    expect(payloads).toEqual([
      expect.objectContaining({ text: "I've saved that preference and will remember it." }),
    ]);
    expect(JSON.stringify(payloads)).not.toContain("memory-lancedb");
  });

  it("does not treat an unowned same-name tool as a persistence mutation", () => {
    const terminal = createToolTerminalObserver("run-third-party-store")(
      failed("memory_store", "store unavailable", {
        arguments: { text: "The user prefers metric units." },
        executionStarted: true,
      }),
    );

    expect(terminal.lastToolError).toMatchObject({ mutatingAction: false });
  });
});

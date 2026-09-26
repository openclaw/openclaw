import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  preExecutionBlockedToolCallIds,
  recordToolExecutionStarted,
  recordToolExecutionTracked,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { Agent } from "./runtime/index.js";
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

function steeringAssistant(content: AssistantMessage["content"]): AssistantMessage {
  const stopReason = content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop";
  return {
    role: "assistant",
    content,
    api: steeringModel.api,
    provider: steeringModel.provider,
    model: steeringModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("tool terminal outcome observer", () => {
  afterEach(() => resetAdjustedParamsByToolCallIdForTests());

  it("does not record a steering skip as a tool failure", () => {
    const terminal = createToolTerminalObserver("run-steering-skip")({
      toolName: "exec",
      arguments: { command: "echo interrupted" },
      executionStarted: false,
      outcome: "failure",
      result: { details: { status: "skipped", deniedReason: "steering" } },
      failure: { error: "Skipped due to queued user message." },
    });

    expect(terminal.lastToolError).toBeUndefined();
    expect(buildPayloads({ lastToolError: terminal.lastToolError })).toEqual([]);
  });

  it("preserves a genuine pre-execution failure across a steering skip", () => {
    const observe = createToolTerminalObserver("run-steering-admission");
    const admissionBlock = observe({
      toolName: "exec",
      arguments: { command: "echo denied" },
      executionStarted: false,
      outcome: "failure",
      result: { details: { status: "blocked", deniedReason: "tool-admission" } },
      failure: { error: "Tool execution was blocked before launch." },
    });

    const afterSteeringSkip = observe({
      toolName: "exec",
      arguments: { command: "echo interrupted" },
      executionStarted: false,
      outcome: "failure",
      result: { details: { status: "skipped", deniedReason: "steering" } },
      failure: { error: "Skipped due to queued user message." },
    });

    expect(admissionBlock.lastToolError).toMatchObject({
      error: "Tool execution was blocked before launch.",
    });
    expect(afterSteeringSkip.lastToolError).toMatchObject({
      error: "Tool execution was blocked before launch.",
    });
    expect(buildPayloads({ lastToolError: afterSteeringSkip.lastToolError })).toEqual([
      expect.objectContaining({ text: "⚠️ Exec blocked", isError: true }),
    ]);
  });

  it("runs the observer through a sequential agent steering reply", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "unexpected second execution" }],
      details: {},
    }));
    const providerRequests: Message[][] = [];
    const observe = createToolTerminalObserver("run-agent-steering");
    const terminalResults: ReturnType<typeof observe>[] = [];
    let providerRequest = 0;
    const streamFn = (_model: Model, context: { messages: Message[] }) => {
      providerRequests.push(context.messages.slice());
      providerRequest += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          providerRequest === 1
            ? steeringAssistant([
                { type: "toolCall", id: "call-first", name: "first", arguments: {} },
                { type: "toolCall", id: "call-second", name: "second", arguments: {} },
              ])
            : steeringAssistant([{ type: "text", text: "steering reply" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const agent = new Agent({
      initialState: {
        model: steeringModel,
        tools: [
          {
            name: "first",
            label: "first",
            description: "Runs the first step.",
            parameters: Type.Object({}),
            execute: async () => {
              firstStarted.resolve();
              await releaseFirst.promise;
              return { content: [{ type: "text", text: "first completed" }], details: {} };
            },
          },
          {
            name: "second",
            label: "second",
            description: "Runs the second step.",
            parameters: Type.Object({}),
            execute: secondExecute,
          },
        ],
      },
      streamFn,
      toolExecution: "sequential",
      afterToolOutcome: async ({ toolCall, args, result, executionStarted, isError }) => {
        terminalResults.push(
          observe({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: args,
            result,
            executionStarted,
            outcome: isError ? "failure" : "success",
            ...(isError ? { failure: { error: "Agent reported a tool error." } } : {}),
          }),
        );
        return { isError };
      },
    });

    const run = agent.prompt("start the sequence");
    await firstStarted.promise;
    agent.steer({ role: "user", content: "change direction", timestamp: Date.now() });
    releaseFirst.resolve();
    await run;

    expect(secondExecute).not.toHaveBeenCalled();
    expect(terminalResults.at(-1)).toMatchObject({ executionStarted: false });
    expect(terminalResults.at(-1)?.lastToolError).toBeUndefined();
    expect(buildPayloads({ lastToolError: terminalResults.at(-1)?.lastToolError })).toEqual([]);
    expect(providerRequests[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-second",
          isError: true,
          details: { status: "skipped", deniedReason: "steering" },
        }),
        expect.objectContaining({ role: "user", content: "change direction" }),
      ]),
    );
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
    observe({
      toolName: "message",
      arguments: { action: "send", target: "123", message: "failed" },
      outcome: "failure",
      failure: { error: "Telegram transport failed" },
    });
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
    const actionA = { action: "send", to: "channel:a", message: "A" };
    const actionB = { action: "send", to: "channel:b", message: "B" };

    observe({
      toolName: "message",
      arguments: actionA,
      outcome: "failure",
      failure: { error: "A failed" },
    });
    observe({
      toolName: "message",
      arguments: actionB,
      outcome: "failure",
      failure: { error: "B failed" },
    });
    const afterRead = observe({ toolName: "read", arguments: {}, outcome: "success" });

    expect(afterRead.lastToolError).toMatchObject({ error: "B failed" });
    const payloads = buildPayloads({ lastToolError: afterRead.lastToolError });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ isError: true });
  });

  it("uses host execution and adjusted-argument evidence before fallback facts", () => {
    const runId = "run-2";
    const toolCallId = "call-1";
    recordToolExecutionTracked(toolCallId, runId);
    adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
      action: "send",
      to: "channel:adjusted",
    });

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:original" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "blocked before execution" },
    });

    expect(resolution).toMatchObject({
      executionStarted: false,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: false,
      lastToolError: { mutatingAction: false },
    });
    expect(adjustedParamsByToolCallId.get(buildAdjustedParamsKey({ runId, toolCallId }))).toEqual({
      action: "send",
      to: "channel:adjusted",
    });
  });

  it("resolves active wrapper truth when a racing runtime omits conservative facts", () => {
    const runId = "run-racing-timeout";
    const toolCallId = "call-racing-timeout";
    recordToolExecutionStarted(toolCallId, runId);
    adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
      action: "send",
      to: "channel:adjusted",
    });

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:original" },
      outcome: "failure",
      failure: { error: "timed out during execution", executionStarted: false },
    });

    expect(resolution).toMatchObject({
      executionStarted: true,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: true,
      lastToolError: { executionStarted: true, mutatingAction: true },
    });
  });

  it("uses settled pre-execution evidence after active tracking is released", () => {
    const runId = "run-3";
    const toolCallId = "call-blocked";
    preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:blocked" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "blocked" },
    });

    expect(resolution).toMatchObject({
      executionStarted: false,
      sideEffectEvidence: false,
      lastToolError: { executionStarted: false, mutatingAction: false },
    });
  });

  it.each([
    {
      name: "pre-execution rejection",
      input: {
        toolName: "message",
        arguments: { action: "send" },
        executionStarted: false,
        outcome: "failure",
        failure: { error: "blocked" },
      },
      state: "uncertain",
    },
    {
      name: "completed read",
      input: { toolName: "message", arguments: { action: "read" }, outcome: "success" },
      state: "read_completed",
    },
    {
      name: "failed read",
      input: {
        toolName: "message",
        arguments: { action: "read" },
        outcome: "failure",
        failure: { error: "read failed" },
      },
      state: "failed_no_effect",
    },
    {
      name: "completed computer observation",
      input: { toolName: "computer", arguments: { action: "list_windows" }, outcome: "success" },
      state: "read_completed",
    },
    {
      name: "failed computer observation",
      input: {
        toolName: "computer",
        arguments: { action: "get_cursor_position" },
        outcome: "failure",
        failure: { error: "observation unavailable" },
      },
      state: "failed_no_effect",
    },
    {
      name: "owner-declared replay-safe failure",
      input: {
        toolName: "plugin_read",
        arguments: {},
        replaySafe: true,
        outcome: "failure",
        failure: { error: "read failed" },
      },
      state: "failed_no_effect",
    },
    {
      name: "completed mutation",
      input: { toolName: "message", arguments: { action: "send" }, outcome: "success" },
      state: "mutation_committed",
    },
    {
      name: "completed unknown operation",
      input: { toolName: "plugin_unknown", arguments: {}, outcome: "success" },
      state: "uncertain",
    },
    {
      name: "failed mutation",
      input: {
        toolName: "message",
        arguments: { action: "send" },
        outcome: "failure",
        failure: { error: "send failed" },
      },
      state: "uncertain",
    },
  ] as const)("records a host-owned effect receipt for $name", ({ input, state }) => {
    expect(createToolTerminalObserver("run-effect-receipt")(input).effectReceipt).toEqual({
      state,
    });
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

    observe({
      toolName: "sessions_spawn",
      arguments: failedArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", failedArgs),
      outcome: "failure",
      failure: { error: "cwd is outside the workspace" },
    });
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

  it("preserves durable memory recall side-effect evidence", () => {
    const observe = createToolTerminalObserver("run-memory");

    expect(
      observe({
        toolName: "memory_search",
        arguments: { query: "recall" },
        outcome: "success",
      }),
    ).toMatchObject({ executionStarted: true, sideEffectEvidence: true });
    expect(
      observe({
        toolName: "memory_get",
        arguments: { path: "memory/notes.md" },
        outcome: "success",
      }),
    ).toMatchObject({ executionStarted: true, sideEffectEvidence: false });
  });

  it.each([
    {
      name: "keyword fallback",
      timedOut: true,
      timeoutMs: 30_000,
      results: [{ path: "memory/one.md" }, { path: "memory/two.md" }],
      expected: "⚠️ Memory Search timed out after 30s; 2 partial results are available.",
    },
    {
      name: "one keyword match",
      timedOut: true,
      timeoutMs: 30_000,
      results: [{ path: "memory/one.md" }],
      expected: "⚠️ Memory Search timed out after 30s; 1 partial result is available.",
    },
    {
      name: "no fallback",
      timedOut: true,
      timeoutMs: 30_000,
      results: [],
      expected: "⚠️ Memory Search timed out after 30s.",
    },
    {
      name: "provider error with timeout wording",
      timedOut: false,
      timeoutMs: 30_000,
      results: [],
      expected: "⚠️ Memory Search failed",
    },
    {
      name: "invalid timeout metadata",
      timedOut: true,
      timeoutMs: -1,
      results: [],
      expected: "⚠️ Memory Search failed",
    },
  ])(
    "preserves $name in the final timeout warning",
    ({ timedOut, timeoutMs, results, expected }) => {
      const terminal = createToolTerminalObserver("run-memory-timeout")({
        toolName: "memory_search",
        arguments: { query: "project notes" },
        outcome: "failure",
        result: {
          details: {
            timedOut,
            timeoutMs,
            partial: true,
            results,
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
    const observation = {
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "429 insufficient_quota" },
      ownerMutation: {
        ownerKey: '["memory-lancedb","memory_store"]',
      },
    } as const;
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
    const terminal = createToolTerminalObserver("run-third-party-store")({
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "store unavailable" },
    });

    expect(terminal.lastToolError).toMatchObject({ mutatingAction: false });
  });

  it("clears a failed persistence action after the same tool succeeds", () => {
    const observe = createToolTerminalObserver("run-memory-store-retry");
    const ownerKey = '["memory-lancedb","memory_store"]';
    const ownerMutation = { ownerKey };

    observe({
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      outcome: "failure",
      failure: { error: "store unavailable" },
      ownerMutation,
    });
    expect(
      observe({
        toolName: "memory_store",
        arguments: { text: "The user prefers imperial units." },
        outcome: "success",
        ownerMutation,
      }).lastToolError,
    ).toBeUndefined();
  });
});

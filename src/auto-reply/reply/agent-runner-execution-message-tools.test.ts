import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installMessageToolTerminalHook } from "../../agents/embedded-agent-runner/run/message-tool-terminal.js";
import type { AfterToolCallContext, Agent } from "../../agents/runtime/index.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { TemplateContext } from "../templating.js";
import {
  createRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const completedMessage = { name: "message", phase: "end", status: "completed" };

function messageTurn(opts: InternalGetReplyOptions = {}) {
  const followupRun = createFollowupRun();
  followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
  return {
    ...createRunAgentTurnParams(followupRun),
    sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
    opts,
    resolvedVerboseLevel: "on" as const,
  };
}

type AgentEvent = Parameters<NonNullable<EmbeddedAgentParams["onAgentEvent"]>>[0];
const messageStart = (read = false): AgentEvent => ({
  stream: "tool",
  data: {
    phase: "start",
    name: "message",
    toolCallId: read ? "message-read-1" : "message-1",
    args: read
      ? { action: "read", threadId: "thread-1" }
      : { action: "send", message: "Visible reply" },
  },
});
const messageEnd = (read = false, title = true): AgentEvent => ({
  stream: "item",
  data: {
    itemId: "tool-message-1",
    phase: "end",
    kind: "tool",
    name: "message",
    ...(title ? { title: "message" } : {}),
    toolCallId: read ? "message-read-1" : "message-1",
    status: "completed",
  },
});
const failedCommand: AgentEvent = {
  stream: "command_output",
  data: {
    itemId: "command:exec-1",
    phase: "end",
    title: "command false",
    toolCallId: "exec-1",
    name: "exec",
    output: "failed command output",
    status: "failed",
    exitCode: 1,
  },
};

it("suppresses progress callbacks after message-tool-only delivery completes", async () => {
  const itemEventGate = createDeferred();
  const itemEventStarted = createDeferred();
  const onItemEvent = vi.fn(async () => {
    itemEventStarted.resolve();
    await itemEventGate.promise;
  });
  const onCommandOutput = vi.fn();
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await params.onAgentEvent?.(messageStart());
    const itemEventPromise = params.onAgentEvent?.(messageEnd());
    await itemEventStarted.promise;
    await params.onAgentEvent?.(failedCommand);
    await params.onAgentEvent?.({
      stream: "item",
      data: {
        kind: "preamble",
        phase: "update",
        itemId: "commentary-1",
        progressText: "This must stay suppressed.",
      },
    });
    itemEventGate.resolve();
    await itemEventPromise;
    return {
      payloads: [],
      didDeliverSourceReplyViaMessageTool: true,
      meta: { terminalReply: { disposition: "silent" } },
    };
  });

  await executeAgentTurn(
    messageTurn({ onItemEvent, onCommandOutput, progressPreambleEnabled: true }),
  );

  expect(onItemEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(completedMessage));
  expect(onCommandOutput).not.toHaveBeenCalled();
  expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "tool_delivered", runStatus: "completed" }),
  );
});

it("settles failed recording without replaying the turn", async () => {
  state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
  state.recordMessageToolRunOutcomeMock.mockRejectedValueOnce(
    new SqliteWorkerError("Outcome could not be confirmed", "outcome-unknown"),
  );
  const followupRun = createFollowupRun();
  followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
  await expect(
    executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun })),
  ).resolves.toMatchObject({
    kind: "success",
    runResult: { payloads: [] },
  });
  expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledTimes(1);
  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
});

it("clears run ownership when model preflight fails", async () => {
  const onAgentRunTerminalOutcome = vi.fn();
  const followupRun = createFollowupRun();
  followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
  const agentRunRegistry = await import("../../infra/agent-run-registry.js");
  const clearAgentRunContext = vi.mocked(agentRunRegistry.clearAgentRunContext);
  const failure = new Error("model preflight failed");
  const modelRead = vi
    .spyOn(
      await import("../../agents/session-model-auto-revert.js"),
      "createAgentPatchedSessionModelRunGuard",
    )
    .mockRejectedValueOnce(failure);

  try {
    await expect(
      executeAgentTurn(
        createMinimalRunAgentTurnParams({
          followupRun,
          opts: { runId: "preflight-failure", onAgentRunTerminalOutcome },
        }),
      ),
    ).rejects.toBe(failure);
  } finally {
    modelRead?.mockRestore();
  }

  expect(clearAgentRunContext).toHaveBeenCalledWith("preflight-failure", expect.any(String));
  expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
  expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      runId: "preflight-failure",
      outcome: "mute",
      runStatus: "errored",
    }),
  );
  expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();
});

it("preserves message-tool-only suppression across fallback candidates", async () => {
  const onItemEvent = vi.fn();
  const onCommandOutput = vi.fn();
  state.runEmbeddedAgentMock
    .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.(messageStart());
      await params.onAgentEvent?.(messageEnd(false, false));
      return { payloads: [], meta: {} };
    })
    .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "end",
          name: "exec",
          output: "must stay suppressed",
          status: "completed",
          exitCode: 0,
        },
      });
      return { payloads: [], meta: { terminalReply: { disposition: "silent" } } };
    });
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params.run("anthropic", "primary", initialFallbackAttemptOptions(params));
    return {
      result: await params.run("openai", "fallback", fallbackAttemptOptions(params, "unknown")),
      provider: "openai",
      model: "fallback",
      attempts: [],
    };
  });

  await executeAgentTurn(messageTurn({ onItemEvent, onCommandOutput }));

  expect(onItemEvent).toHaveBeenCalledTimes(1);
  expect(onCommandOutput).not.toHaveBeenCalled();
});

it("keeps progress callbacks active after message-tool-only reads", async () => {
  const onItemEvent = vi.fn();
  const onCommandOutput = vi.fn();
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await params.onAgentEvent?.(messageStart(true));
    await params.onAgentEvent?.(messageEnd(true));
    await params.onAgentEvent?.(failedCommand);
    return { payloads: [], meta: { terminalReply: { disposition: "silent" } } };
  });

  await executeAgentTurn(messageTurn({ onItemEvent, onCommandOutput }));

  expect(onItemEvent).toHaveBeenCalledWith(expect.objectContaining(completedMessage));
  expect(onCommandOutput).toHaveBeenCalledWith(
    expect.objectContaining({ output: "failed command output", status: "failed" }),
  );
});

async function emitSyntheticSourceReply(
  params: EmbeddedAgentParams,
  kind: "completed" | "progress" | "partial",
): Promise<void> {
  const agent = {} as Agent;
  installMessageToolTerminalHook({
    agent,
    sourceReplyDeliveryMode: "message_tool_only",
    onCompletedSourceReply: params.onCompletedSourceReplyDelivered,
  });
  const args = {
    action: "send",
    message: kind === "completed" ? "Completed answer" : "Still working",
    ...(kind === "progress" ? { final: false } : {}),
  };
  await agent.afterToolCall?.({
    toolCall: { name: "message", arguments: args },
    args,
    result: {
      content: [],
      details: {
        messageDelivery: {
          status: "settled",
          partialDelivery: kind === "partial",
          createdThreadIds: [],
          sourceReplyDelivered: true,
        },
      },
    },
    isError: kind === "partial",
  } as unknown as AfterToolCallContext);
}

it("does not fallback or surface an error after a completed source reply", async () => {
  state.runEmbeddedAgentMock
    .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await emitSyntheticSourceReply(params, "completed");
      throw new Error("plugin state failed after delivery");
    })
    .mockRejectedValueOnce(new Error("401 Unauthorized"));
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    try {
      return {
        result: await params.run("anthropic", "primary", initialFallbackAttemptOptions(params)),
        provider: "anthropic",
        model: "primary",
        attempts: [],
      };
    } catch (error) {
      if (params.canFallbackAfterError?.() === false) {
        throw error;
      }
      return {
        result: await params.run("xai", "fallback", fallbackAttemptOptions(params, "unknown")),
        provider: "xai",
        model: "fallback",
        attempts: [],
      };
    }
  });

  const result = await executeAgentTurn(messageTurn());

  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ kind: "final", payload: { text: "NO_REPLY" } });
});

it("does not fallback after a plugin harness returns a completed source receipt", async () => {
  state.runEmbeddedAgentMock
    .mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      sourceReplyDelivered: true,
      meta: { error: { message: "native finalization failed after delivery" } },
    })
    .mockRejectedValueOnce(new Error("401 Unauthorized"));
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    const result = await params.run("codex", "gpt-5.4", initialFallbackAttemptOptions(params));
    expect(params.canFallbackAfterError?.()).toBe(false);
    return { result, provider: "codex", model: "gpt-5.4", attempts: [] };
  });

  const result = await executeAgentTurn(messageTurn());

  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    kind: "success",
    runResult: {
      payloads: [{ text: "NO_REPLY" }],
      sourceReplyDelivered: true,
    },
  });
});

it("keeps fallback available after a plugin harness returns only source progress", async () => {
  state.runEmbeddedAgentMock
    .mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      sourceReplyDelivered: true,
      messagingToolSentTargets: [{ sourceReplyFinal: false }],
      meta: { error: { message: "native finalization failed after progress" } },
    })
    .mockResolvedValueOnce({
      payloads: [{ text: "Fallback answer" }],
      meta: {},
    });
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params.run("codex", "gpt-5.4", initialFallbackAttemptOptions(params));
    expect(params.canFallbackAfterError?.()).toBe(true);
    const result = await params.run(
      "openai",
      "fallback",
      fallbackAttemptOptions(params, "unknown"),
    );
    return { result, provider: "openai", model: "fallback", attempts: [] };
  });

  const result = await executeAgentTurn(messageTurn());

  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    kind: "success",
    runResult: { payloads: [{ text: "Fallback answer" }] },
  });
});

it("keeps fallback available for legacy-only plugin delivery evidence", async () => {
  state.runEmbeddedAgentMock
    .mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      sourceReplyDeliveryState: "delivered",
      meta: { error: { message: "legacy runtime failed after coarse delivery telemetry" } },
    })
    .mockResolvedValueOnce({
      payloads: [{ text: "Fallback answer" }],
      meta: {},
    });
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params.run("legacy", "primary", initialFallbackAttemptOptions(params));
    expect(params.canFallbackAfterError?.()).toBe(true);
    const result = await params.run(
      "openai",
      "fallback",
      fallbackAttemptOptions(params, "unknown"),
    );
    return { result, provider: "openai", model: "fallback", attempts: [] };
  });

  const result = await executeAgentTurn(messageTurn());

  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    kind: "success",
    runResult: { payloads: [{ text: "Fallback answer" }] },
  });
});

it.each(["progress", "partial delivery"])(
  "keeps fallback available after unfinished source %s",
  async (sourceReplyKind) => {
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await emitSyntheticSourceReply(
          params,
          sourceReplyKind === "progress" ? "progress" : "partial",
        );
        throw new Error("candidate failed before a completed reply");
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "Fallback answer" }],
        meta: {},
      });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      try {
        return {
          result: await params.run("anthropic", "primary", initialFallbackAttemptOptions(params)),
          provider: "anthropic",
          model: "primary",
          attempts: [],
        };
      } catch {
        expect(params.canFallbackAfterError?.()).toBe(true);
        return {
          result: await params.run("xai", "fallback", fallbackAttemptOptions(params, "unknown")),
          provider: "xai",
          model: "fallback",
          attempts: [],
        };
      }
    });

    const result = await executeAgentTurn(messageTurn());

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: "success",
      runResult: { payloads: [{ text: "Fallback answer" }] },
    });
  },
);

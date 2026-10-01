import { describe, expect, it, vi } from "vitest";
import { installMessageToolOnlyTerminalHook } from "../../agents/embedded-agent-runner/run/message-tool-terminal.js";
import type { AfterToolCallContext, Agent } from "../../agents/runtime/index.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
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

async function emitSyntheticSourceReply(
  params: EmbeddedAgentParams,
  kind: "completed" | "progress" | "partial",
): Promise<void> {
  const agent = {} as Agent;
  installMessageToolOnlyTerminalHook({
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

describe("executeAgentTurn: message tool progress", () => {
  it("suppresses progress callbacks after message-tool-only delivery completes", async () => {
    let releaseItemEvent: (() => void) | undefined;
    const itemEventGate = new Promise<void>((resolve) => {
      releaseItemEvent = resolve;
    });
    let markItemEventStarted: (() => void) | undefined;
    const itemEventStarted = new Promise<void>((resolve) => {
      markItemEventStarted = resolve;
    });
    const onItemEvent = vi.fn(async () => {
      markItemEventStarted?.();
      await itemEventGate;
    });
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "message",
          toolCallId: "message-1",
          args: {
            action: "send",
            message: "Visible reply",
          },
        },
      });
      const itemEventPromise = params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool-message-1",
          phase: "end",
          kind: "tool",
          title: "message",
          name: "message",
          toolCallId: "message-1",
          status: "completed",
        },
      });
      await itemEventStarted;
      await params.onAgentEvent?.({
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
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          kind: "preamble",
          phase: "update",
          itemId: "commentary-1",
          progressText: "This must stay suppressed.",
        },
      });
      releaseItemEvent?.();
      await itemEventPromise;
      return {
        payloads: [{ text: "NO_REPLY" }],
        didDeliverSourceReplyViaMessageTool: true,
        meta: {},
      };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onItemEvent,
        onCommandOutput,
        progressPreambleEnabled: true,
      } satisfies InternalGetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "message",
        phase: "end",
        status: "completed",
      }),
    );
    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "tool_delivered",
        runStatus: "completed",
      }),
    );
  });

  it("records mute when a message-tool-only run completes without a send", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({ followupRun, opts: { onAgentRunTerminalOutcome } }),
    );

    expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("completed");
    expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "mute", runStatus: "completed" }),
    );
  });

  it.each([false, true])(
    "settles failed recording without replaying the turn (runFailed=%s)",
    async (runFailed) => {
      const original = new Error("invalid image metadata");
      if (runFailed) {
        state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(original);
      } else {
        state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
      }
      state.recordMessageToolRunOutcomeMock.mockRejectedValueOnce(
        new SqliteWorkerError("Outcome could not be confirmed", "outcome-unknown"),
      );
      const followupRun = createFollowupRun();
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const execution = executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
      if (runFailed) {
        await expect(execution).rejects.toBe(original);
      } else {
        await expect(execution).resolves.toMatchObject({
          kind: "success",
          runResult: { payloads: [] },
        });
      }
      expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledTimes(1);
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(runFailed ? 0 : 1);
    },
  );

  it.each([false, true])(
    "records failed execution independently of delivery (%s)",
    async (delivered) => {
      const onAgentRunTerminalOutcome = vi.fn();
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [],
        didDeliverSourceReplyViaMessageTool: delivered,
        meta: { error: { message: "provider crashed" } },
      });
      const followupRun = createFollowupRun();
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await executeAgentTurn(
        createMinimalRunAgentTurnParams({ followupRun, opts: { onAgentRunTerminalOutcome } }),
      );

      expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
      expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: delivered ? "tool_delivered" : "mute",
          runStatus: "errored",
        }),
      );
    },
  );

  it("clears run ownership when image preflight fails", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const clearAgentRunContext = vi.mocked(agentRunRegistry.clearAgentRunContext);
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image metadata"));

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await expect(
      executeAgentTurn(
        createMinimalRunAgentTurnParams({
          followupRun,
          opts: { runId: "preflight-failure", onAgentRunTerminalOutcome },
        }),
      ),
    ).rejects.toThrow("invalid image metadata");

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
        await params.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "start",
            name: "message",
            toolCallId: "message-1",
            args: { action: "send", message: "Visible reply" },
          },
        });
        await params.onAgentEvent?.({
          stream: "item",
          data: {
            itemId: "tool-message-1",
            phase: "end",
            kind: "tool",
            name: "message",
            toolCallId: "message-1",
            status: "completed",
          },
        });
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
        return { payloads: [{ text: "NO_REPLY" }], meta: {} };
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onItemEvent, onCommandOutput } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(onCommandOutput).not.toHaveBeenCalled();
  });

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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {} satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {} satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "success",
      runResult: {
        payloads: [{ text: "NO_REPLY" }],
        sourceReplyDelivered: true,
      },
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
      opts: {} satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

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
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          try {
            return {
              result: await params.run(
                "anthropic",
                "primary",
                initialFallbackAttemptOptions(params),
              ),
              provider: "anthropic",
              model: "primary",
              attempts: [],
            };
          } catch {
            expect(params.canFallbackAfterError?.()).toBe(true);
            return {
              result: await params.run(
                "xai",
                "fallback",
                fallbackAttemptOptions(params, "unknown"),
              ),
              provider: "xai",
              model: "fallback",
              attempts: [],
            };
          }
        },
      );

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const followupRun = createFollowupRun();
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      const result = await executeAgentTurn({
        commandBody: "hello",
        followupRun,
        sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
        opts: {} satisfies GetReplyOptions,
        typingSignals: createMockTypingSignaler(),
        ...createAgentTurnExecutionDefaults(),
        resolvedVerboseLevel: "on",
      });

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        kind: "success",
        runResult: { payloads: [{ text: "Fallback answer" }] },
      });
    },
  );

  it("keeps opted-in progress callbacks active after message-tool-only delivery completes", async () => {
    const onToolStart = vi.fn();
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "message",
          toolCallId: "message-1",
          args: {
            action: "send",
            message: "Visible reply",
          },
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool-message-1",
          phase: "end",
          kind: "tool",
          title: "message",
          name: "message",
          toolCallId: "message-1",
          status: "completed",
        },
      });
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          toolCallId: "bash-1",
          args: {
            command: "sleep 6",
          },
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:bash-1",
          phase: "end",
          title: "sleep 6",
          toolCallId: "bash-1",
          name: "bash",
          output: "done",
          status: "completed",
          exitCode: 0,
        },
      });
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onCommandOutput,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bash",
        phase: "start",
        args: { command: "sleep 6" },
        detailMode: undefined,
      }),
    );
    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bash",
        output: "done",
        status: "completed",
      }),
    );
  });

  it("keeps progress callbacks active after message-tool-only reads", async () => {
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "start",
          name: "message",
          toolCallId: "message-read-1",
          args: {
            action: "read",
            threadId: "thread-1",
          },
        },
      });
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool-message-1",
          phase: "end",
          kind: "tool",
          title: "message",
          name: "message",
          toolCallId: "message-read-1",
          status: "completed",
        },
      });
      await params.onAgentEvent?.({
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
      });
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onItemEvent,
        onCommandOutput,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      resolvedVerboseLevel: "on",
    });

    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "message",
        phase: "end",
        status: "completed",
      }),
    );
    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "failed command output",
        status: "failed",
      }),
    );
  });
});

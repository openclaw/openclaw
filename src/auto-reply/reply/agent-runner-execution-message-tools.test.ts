import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

function messageRun() {
  const followupRun = createFollowupRun();
  followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
  return followupRun;
}

function messageTurn(opts: InternalGetReplyOptions = {}) {
  return {
    ...createRunAgentTurnParams(messageRun()),
    sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
    opts,
    resolvedVerboseLevel: "on" as const,
  };
}

type AgentEvent = Parameters<NonNullable<EmbeddedAgentParams["onAgentEvent"]>>[0];
function mockEvents(events: AgentEvent[], silent = true) {
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    for (const event of events) {
      await params.onAgentEvent?.(event);
    }
    return {
      payloads: [],
      meta: silent ? { terminalReply: { disposition: "silent" as const } } : {},
    };
  });
}

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
  await expect(
    executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun: messageRun() })),
  ).resolves.toMatchObject({
    kind: "success",
    runResult: { payloads: [] },
  });
  expect(state.recordMessageToolRunOutcomeMock).toHaveBeenCalledTimes(1);
  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
});

it("clears run ownership when model preflight fails", async () => {
  const onAgentRunTerminalOutcome = vi.fn();
  const { clearAgentRunContext } = await import("../../infra/agent-run-registry.js");
  const failure = new Error("model preflight failed");
  using _ = vi
    .spyOn(
      await import("../../agents/session-model-auto-revert.js"),
      "createAgentPatchedSessionModelRunGuard",
    )
    .mockRejectedValueOnce(failure);

  await expect(
    executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun: messageRun(),
        opts: { runId: "preflight-failure", onAgentRunTerminalOutcome },
      }),
    ),
  ).rejects.toBe(failure);

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
  mockEvents([messageStart(), messageEnd(false, false)], false);
  mockEvents([
    {
      stream: "command_output",
      data: {
        itemId: "command:exec-1",
        phase: "end",
        name: "exec",
        output: "must stay suppressed",
        status: "completed",
        exitCode: 0,
      },
    },
  ]);
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
  mockEvents([messageStart(true), messageEnd(true), failedCommand]);

  await executeAgentTurn(messageTurn({ onItemEvent, onCommandOutput }));

  expect(onItemEvent).toHaveBeenCalledWith(expect.objectContaining(completedMessage));
  expect(onCommandOutput).toHaveBeenCalledWith(
    expect.objectContaining({ output: "failed command output", status: "failed" }),
  );
});

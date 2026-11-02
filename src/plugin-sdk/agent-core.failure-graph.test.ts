import { setImmediate as nextTurn } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import {
  createTurnSequenceStream,
  finishMessageStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  startToolCalls,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import {
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
} from "../../packages/agent-core/src/internal-hooks.js";
import { SqliteTranscriptMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../infra/sqlite-worker-contract.js";
import { Agent, type AgentOptions, type AgentTool } from "./agent-core.js";

const emptyResult = async () => ({ content: [], details: {} });
const tool = (name: string, execute: AgentTool["execute"]) => ({ ...makeTool(name), execute });
const preparedTool = (name: string, execute = emptyResult) =>
  attachInternalToolExecutionPreparer(makeTool(name), async () => ({
    kind: "ready",
    args: {},
    execute,
    dispose() {},
  }));

function scenario(tools: AgentTool[], options: AgentOptions = {}, streamed = false) {
  const calls = tools.map(({ name }) => makeCall(name));
  const streamFn = vi.fn(
    options.streamFn ??
      (streamed
        ? () => {
            const stream = createAssistantMessageEventStream();
            const asyncCalls = calls.map((call) => Object.assign(call, { async: true as const }));
            startToolCalls(stream, asyncCalls);
            finishMessageStream(stream, makeAssistantMessage(asyncCalls));
            return stream;
          }
        : createTurnSequenceStream([calls])),
  );
  const agent = new Agent({
    toolExecution: "parallel",
    ...options,
    streamFn,
    initialState: { tools },
  });
  return { agent, streamFn };
}

async function failedPrompt(agent: Agent, streamFn?: ReturnType<typeof scenario>["streamFn"]) {
  const outcome = await agent.prompt("Run tools").catch((error: unknown) => error);
  expect(agent.state.isStreaming).toBe(false);
  if (streamFn) {
    expect(streamFn).toHaveBeenCalledOnce();
  }
  return outcome;
}

function expectFailureGraph(error: unknown, ...originals: Error[]) {
  expect(hasSqliteWorkerOutcomeUnknown(error)).toBe(true);
  const graph = collectNestedErrorCandidates(error);
  for (const original of originals) {
    expect(graph).toContain(original);
  }
}

it("stops before another model request when the outcome hook rejects an unknown write", async () => {
  const uncertain = new SqliteWorkerError("Synthetic outcome hook failure", "outcome-unknown");
  const executeWrite = vi.fn(emptyResult);
  const executeNext = vi.fn(emptyResult);
  const { agent, streamFn } = scenario([tool("write", executeWrite), tool("next", executeNext)], {
    streamFn: createTurnSequenceStream([[makeCall("write")], [makeCall("next")]]),
    afterToolOutcome: async ({ toolCall }) => {
      if (toolCall.name === "write") {
        throw uncertain;
      }
    },
  });
  const outcome = await failedPrompt(agent, streamFn);
  expectFailureGraph(outcome, uncertain);
  expect(outcome).toBe(uncertain);
  expect(executeWrite).toHaveBeenCalledOnce();
  expect(executeNext).not.toHaveBeenCalled();
});

it.each(["execution", "after-call"] as const)(
  "retains an uncertain sibling when the first parallel failure is in %s",
  async (phase) => {
    const primary = new SqliteTranscriptMutationConflictError("synthetic-session");
    const uncertain = new SqliteWorkerError("Synthetic unsettled sibling", "outcome-unknown");
    const siblingStarted = Promise.withResolvers<void>();
    let siblingSettled = false;
    const { agent, streamFn } = scenario(
      [
        tool("first", async () => {
          await siblingStarted.promise;
          if (phase === "execution") {
            throw primary;
          }
          return emptyResult();
        }),
        tool("sibling", async () => {
          siblingStarted.resolve();
          await nextTurn();
          siblingSettled = true;
          throw uncertain;
        }),
      ],
      {
        afterToolCall: async ({ toolCall }) => {
          if (phase === "after-call" && toolCall.name === "first") {
            throw primary;
          }
        },
      },
    );
    const outcome = await failedPrompt(agent, streamFn);
    expectFailureGraph(outcome, primary, uncertain);
    expect(outcome).toMatchObject({ cause: primary });
    expect(siblingSettled).toBe(true);
  },
);

it.each([false, true])(
  "retains a sibling failure while publishing a pre-start completion (pre-start rejection: %s)",
  async (preStartRejection) => {
    const primary = new Error("Synthetic pre-start result publication failure");
    const uncertain = new SqliteWorkerError("Synthetic unsettled sibling", "outcome-unknown");
    const releaseSibling = Promise.withResolvers<void>();
    let siblingEntered = false;
    let siblingSettled = false;
    let completionFailed = false;
    const failSibling = async () => {
      siblingEntered = true;
      if (!preStartRejection) {
        await releaseSibling.promise;
      }
      await nextTurn();
      siblingSettled = true;
      throw uncertain;
    };
    const sibling = preStartRejection
      ? preparedTool("sibling", failSibling)
      : tool("sibling", failSibling);
    const { agent, streamFn } = scenario([preparedTool("prestart"), sibling]);
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "prestart") {
        completionFailed = true;
        releaseSibling.resolve();
        throw primary;
      }
    });
    const outcome = await failedPrompt(agent, streamFn);
    expectFailureGraph(outcome, primary, uncertain);
    expect(completionFailed && siblingEntered && siblingSettled).toBe(true);
  },
);

it("publishes a successful accepted sibling after a pre-start completion fails", async () => {
  const uncertain = new SqliteWorkerError("Synthetic completion failure", "outcome-unknown");
  const releaseSibling = Promise.withResolvers<void>();
  const executeSibling = vi.fn(async () => {
    await releaseSibling.promise;
    return { content: [{ type: "text" as const, text: "Accepted work completed" }], details: {} };
  });
  const siblingEnds: string[] = [];
  const { agent, streamFn } = scenario(
    [preparedTool("prestart"), tool("sibling", executeSibling)],
    {
      afterToolCall: async ({ toolCall }) =>
        toolCall.name === "sibling"
          ? { content: [{ type: "text", text: "Finalized accepted work" }] }
          : undefined,
      afterToolOutcome: async ({ toolCall }) =>
        toolCall.name === "sibling" ? { details: { outcomeObserved: true } } : undefined,
    },
  );
  agent.subscribe((event) => {
    if (event.type !== "tool_execution_end") {
      return;
    }
    if (event.toolCallId === "prestart") {
      releaseSibling.resolve();
      throw uncertain;
    }
    siblingEnds.push(event.toolCallId);
  });
  const outcome = await failedPrompt(agent, streamFn);
  expectFailureGraph(outcome, uncertain);
  expect(executeSibling).toHaveBeenCalledOnce();
  expect(siblingEnds).toEqual(["sibling"]);
  const siblingResults = agent.state.messages.filter(
    (message) => message.role === "toolResult" && message.toolCallId === "sibling",
  );
  expect(siblingResults).toEqual([
    expect.objectContaining({
      role: "toolResult",
      toolCallId: "sibling",
      content: [{ type: "text", text: "Finalized accepted work" }],
      details: { outcomeObserved: true },
      isError: false,
    }),
  ]);
});

it.each(["turn-end", "skipped-tail"] as const)(
  "retains an accepted unknown outcome when %s publication also fails",
  async (publication) => {
    const uncertain = new SqliteWorkerError("Synthetic unconfirmed write", "outcome-unknown");
    const publicationFailure = new Error("Synthetic terminal publication failure");
    const executeTail = vi.fn(emptyResult);
    let writeSettled = false;
    let publicationFailed = false;
    const { agent, streamFn } = scenario(
      [
        tool("write", async () => {
          writeSettled = true;
          throw uncertain;
        }),
        tool("tail", executeTail),
      ],
      {
        toolExecution: "sequential",
        streamFn: createTurnSequenceStream([
          [makeCall("write"), ...(publication === "skipped-tail" ? [makeCall("tail")] : [])],
        ]),
      },
    );
    agent.subscribe((event) => {
      if (
        !publicationFailed &&
        (publication === "turn-end"
          ? event.type === "turn_end"
          : event.type === "message_end" &&
            event.message.role === "toolResult" &&
            event.message.toolCallId === "tail")
      ) {
        publicationFailed = true;
        throw publicationFailure;
      }
    });
    const outcome = await failedPrompt(agent, streamFn);
    expectFailureGraph(outcome, uncertain, publicationFailure);
    expect(writeSettled && publicationFailed).toBe(true);
    expect(executeTail).not.toHaveBeenCalled();
  },
);

it("retains returned and rejected failures from separate streamed tool batches", async () => {
  const primary = new SqliteTranscriptMutationConflictError("synthetic-streamed-session");
  const uncertain = new SqliteWorkerError("Synthetic unsettled result", "outcome-unknown");
  const siblingStarted = Promise.withResolvers<void>();
  const primaryFailed = Promise.withResolvers<void>();
  let siblingSettled = false;
  let publicationFailed = false;
  const { agent, streamFn } = scenario(
    [
      tool("first", async () => {
        await siblingStarted.promise;
        primaryFailed.resolve();
        throw primary;
      }),
      tool("sibling", async () => {
        siblingStarted.resolve();
        await primaryFailed.promise;
        await nextTurn();
        siblingSettled = true;
        return emptyResult();
      }),
    ],
    {},
    true,
  );
  agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "toolResult" &&
      event.message.toolCallId === "sibling"
    ) {
      publicationFailed = true;
      throw uncertain;
    }
  });
  const outcome = await failedPrompt(agent, streamFn);
  expectFailureGraph(outcome, primary, uncertain);
  expect(siblingSettled && publicationFailed).toBe(true);
});

it("releases an admitted sequential async batch when its predecessor fails locally", async () => {
  const uncertain = new SqliteWorkerError("Synthetic predecessor failure", "outcome-unknown");
  const waitingAdmitted = Promise.withResolvers<void>();
  const executeWaiting = vi.fn(emptyResult);
  const releaseWaiting = vi.fn();
  const beforeCalls: string[] = [];
  const { agent, streamFn } = scenario(
    [
      tool("first", async () => {
        await waitingAdmitted.promise;
        await nextTurn();
        throw uncertain;
      }),
      { ...tool("waiting", executeWaiting), executionMode: "sequential" },
    ],
    {
      beforeToolCall: async ({ toolCall }) => {
        beforeCalls.push(toolCall.name);
      },
    },
    true,
  );
  setInternalBeforeToolBatch(agent, async ({ calls: admittedCalls }) => {
    if (admittedCalls.some(({ toolCall }) => toolCall.name === "waiting")) {
      waitingAdmitted.resolve();
      return attachInternalToolBatchLifecycle({}, { releaseSkippedCalls: releaseWaiting });
    }
    return undefined;
  });
  const outcome = await failedPrompt(agent, streamFn);
  expectFailureGraph(outcome, uncertain);
  expect(releaseWaiting).toHaveBeenCalledExactlyOnceWith(["waiting"]);
  expect(beforeCalls).toEqual(["first"]);
  expect(executeWaiting).not.toHaveBeenCalled();
});

it.each(["reject", "complete"] as const)(
  "settles an invoked pending guard that later %ss",
  async (settlement) => {
    const primary = new SqliteTranscriptMutationConflictError("synthetic-pending-guard");
    const uncertain = new SqliteWorkerError("Synthetic guard failure", "outcome-unknown");
    const guardEntered = Promise.withResolvers<void>();
    let guardSettled = false;
    const sibling = attachInternalToolExecutionPreparer(makeTool("sibling"), async () => ({
      kind: "ready",
      args: {},
      async execute() {
        guardEntered.resolve();
        await nextTurn();
        await nextTurn();
        guardSettled = true;
        if (settlement === "reject") {
          throw uncertain;
        }
        return { content: [{ type: "text", text: "Prepared result" }], details: {} };
      },
      dispose() {},
    }));
    const { agent, streamFn } = scenario([
      tool("first", async () => {
        await guardEntered.promise;
        throw primary;
      }),
      sibling,
    ]);
    const siblingEnds: unknown[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "sibling") {
        siblingEnds.push(event.result);
      }
    });
    const outcome = await failedPrompt(agent, streamFn);
    if (settlement === "reject") {
      expectFailureGraph(outcome, primary, uncertain);
    } else {
      expect(collectNestedErrorCandidates(outcome)).toContain(primary);
      expect(siblingEnds).toEqual([
        { content: [{ type: "text", text: "Prepared result" }], details: {} },
      ]);
      expect(agent.state.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "sibling",
          content: [{ type: "text", text: "Prepared result" }],
        }),
      );
    }
    expect(guardSettled).toBe(true);
  },
);

it("keeps pre-start publication failure primary when admission release also fails", async () => {
  const uncertain = new SqliteWorkerError("Synthetic publication failure", "outcome-unknown");
  const cleanup = new Error("Synthetic admission release failure");
  const { agent } = scenario([preparedTool("prestart")]);
  setInternalBeforeToolBatch(agent, async () =>
    attachInternalToolBatchLifecycle(
      {},
      {
        releaseSkippedCalls() {
          throw cleanup;
        },
      },
    ),
  );
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      throw uncertain;
    }
  });
  const outcome = await failedPrompt(agent);
  expectFailureGraph(outcome, uncertain, cleanup);
  expect(outcome).toMatchObject({ cause: uncertain });
});

it.each(["execution", "admission", "ordinary"] as const)(
  "retains %s and cleanup failures while draining every accepted progress update",
  async (phase) => {
    const primary =
      phase === "execution"
        ? new SqliteWorkerError("Synthetic execution failure", "outcome-unknown")
        : new Error("Synthetic primary failure");
    const publication = new SqliteWorkerError(
      "Synthetic update failure",
      phase === "execution" ? "unavailable" : "outcome-unknown",
    );
    const latePublication = new Error("Synthetic late update failure");
    const cleanup = new Error("Synthetic preparation disposal failure");
    let lateSettled = false;
    let updateCount = 0;
    const progressTool = attachInternalToolExecutionPreparer(
      makeTool("progress"),
      async ({ onUpdate }) => ({
        kind: "ready",
        args: {},
        async execute(onStart) {
          onUpdate?.({ content: [], details: { update: 1 } });
          onUpdate?.({ content: [], details: { update: 2 } });
          onStart?.();
          throw primary;
        },
        dispose() {
          throw cleanup;
        },
      }),
    );
    const { agent } = scenario([progressTool]);
    if (phase === "admission") {
      setInternalBeforeToolBatch(agent, async () =>
        attachInternalToolBatchLifecycle(
          {},
          {
            commitReadyCalls() {
              throw primary;
            },
          },
        ),
      );
    }
    agent.subscribe(async (event) => {
      if (event.type !== "tool_execution_update") {
        return;
      }
      if (++updateCount === 1) {
        throw publication;
      }
      await nextTurn();
      lateSettled = true;
      throw latePublication;
    });
    const outcome = await failedPrompt(agent);
    expectFailureGraph(outcome, primary, publication, latePublication, cleanup);
    expect(lateSettled).toBe(true);
  },
);

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
import { Agent } from "./agent-core.js";

function expectFailureGraph(error: unknown, ...originals: Error[]) {
  expect(hasSqliteWorkerOutcomeUnknown(error)).toBe(true);
  const graph = collectNestedErrorCandidates(error);
  for (const original of originals) {
    expect(graph).toContain(original);
  }
}

it("stops before another model request when the outcome hook rejects an unknown write", async () => {
  const uncertain = new SqliteWorkerError("Synthetic outcome hook failure", "outcome-unknown");
  const executeWrite = vi.fn(async () => ({ content: [], details: {} }));
  const executeNext = vi.fn(async () => ({ content: [], details: {} }));
  const streamFn = vi.fn(createTurnSequenceStream([[makeCall("write")], [makeCall("next")]]));
  const agent = new Agent({
    streamFn,
    afterToolOutcome: async ({ toolCall }) => {
      if (toolCall.name === "write") {
        throw uncertain;
      }
    },
    initialState: {
      tools: [
        { ...makeTool("write"), execute: executeWrite },
        { ...makeTool("next"), execute: executeNext },
      ],
    },
  });
  const outcome = await agent.prompt("Write and continue").catch((error: unknown) => error);
  expectFailureGraph(outcome, uncertain);
  expect(outcome).toBe(uncertain);
  expect(executeWrite).toHaveBeenCalledOnce();
  expect(streamFn).toHaveBeenCalledOnce();
  expect(executeNext).not.toHaveBeenCalled();
  expect(agent.state.isStreaming).toBe(false);
});

it.each(["execution", "after-call"] as const)(
  "retains an uncertain sibling when the first parallel failure is in %s",
  async (phase) => {
    const primary = new SqliteTranscriptMutationConflictError("synthetic-session");
    const uncertain = new SqliteWorkerError("Synthetic unsettled sibling", "outcome-unknown");
    const siblingStarted = Promise.withResolvers<void>();
    let siblingSettled = false;
    const streamFn = vi.fn(createTurnSequenceStream([[makeCall("first"), makeCall("sibling")]]));
    const agent = new Agent({
      toolExecution: "parallel",
      streamFn,
      afterToolCall: async ({ toolCall }) => {
        if (phase === "after-call" && toolCall.name === "first") {
          throw primary;
        }
      },
      initialState: {
        tools: [
          {
            ...makeTool("first"),
            async execute() {
              await siblingStarted.promise;
              if (phase === "execution") {
                throw primary;
              }
              return { content: [], details: {} };
            },
          },
          {
            ...makeTool("sibling"),
            async execute() {
              siblingStarted.resolve();
              await nextTurn();
              siblingSettled = true;
              throw uncertain;
            },
          },
        ],
      },
    });
    const outcome = await agent.prompt("Run both tools").catch((error: unknown) => error);
    expectFailureGraph(outcome, primary, uncertain);
    expect(outcome).toMatchObject({ cause: primary });
    expect(siblingSettled).toBe(true);
    expect(streamFn).toHaveBeenCalledOnce();
    expect(agent.state.isStreaming).toBe(false);
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
    const prestart = attachInternalToolExecutionPreparer(makeTool("prestart"), async () => ({
      kind: "ready",
      args: {},
      execute: async () => ({ content: [], details: {} }),
      dispose() {},
    }));
    const failSibling = async () => {
      siblingEntered = true;
      if (!preStartRejection) {
        await releaseSibling.promise;
      }
      await nextTurn();
      siblingSettled = true;
      throw uncertain;
    };
    const sibling = { ...makeTool("sibling"), execute: failSibling };
    if (preStartRejection) {
      attachInternalToolExecutionPreparer(sibling, async () => ({
        kind: "ready",
        args: {},
        execute: failSibling,
        dispose() {},
      }));
    }
    const streamFn = vi.fn(createTurnSequenceStream([[makeCall("prestart"), makeCall("sibling")]]));
    const agent = new Agent({
      toolExecution: "parallel",
      streamFn,
      initialState: { tools: [prestart, sibling] },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "prestart") {
        completionFailed = true;
        releaseSibling.resolve();
        throw primary;
      }
    });
    const outcome = await agent
      .prompt("Complete preparation and drain the sibling")
      .catch((error: unknown) => error);
    expectFailureGraph(outcome, primary, uncertain);
    expect(completionFailed && siblingEntered && siblingSettled).toBe(true);
    expect(streamFn).toHaveBeenCalledOnce();
    expect(agent.state.isStreaming).toBe(false);
  },
);

it("publishes a successful accepted sibling after a pre-start completion fails", async () => {
  const uncertain = new SqliteWorkerError("Synthetic completion failure", "outcome-unknown");
  const releaseSibling = Promise.withResolvers<void>();
  const executeSibling = vi.fn(async () => {
    await releaseSibling.promise;
    return { content: [{ type: "text" as const, text: "Accepted work completed" }], details: {} };
  });
  const prestart = attachInternalToolExecutionPreparer(makeTool("prestart"), async () => ({
    kind: "ready",
    args: {},
    execute: async () => ({ content: [], details: {} }),
    dispose() {},
  }));
  const streamFn = vi.fn(createTurnSequenceStream([[makeCall("prestart"), makeCall("sibling")]]));
  const siblingEnds: string[] = [];
  const agent = new Agent({
    toolExecution: "parallel",
    streamFn,
    afterToolCall: async ({ toolCall }) =>
      toolCall.name === "sibling"
        ? { content: [{ type: "text", text: "Finalized accepted work" }] }
        : undefined,
    afterToolOutcome: async ({ toolCall }) =>
      toolCall.name === "sibling" ? { details: { outcomeObserved: true } } : undefined,
    initialState: { tools: [prestart, { ...makeTool("sibling"), execute: executeSibling }] },
  });
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
  const outcome = await agent.prompt("Complete both tools").catch((error: unknown) => error);
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
  expect(streamFn).toHaveBeenCalledOnce();
  expect(agent.state.isStreaming).toBe(false);
});

it.each(["turn-end", "skipped-tail"] as const)(
  "retains an accepted unknown outcome when %s publication also fails",
  async (publication) => {
    const uncertain = new SqliteWorkerError("Synthetic unconfirmed write", "outcome-unknown");
    const publicationFailure = new Error("Synthetic terminal publication failure");
    const executeTail = vi.fn(async () => ({ content: [], details: {} }));
    let writeSettled = false;
    let publicationFailed = false;
    const calls = [
      makeCall("write"),
      ...(publication === "skipped-tail" ? [makeCall("tail")] : []),
    ];
    const streamFn = vi.fn(createTurnSequenceStream([calls]));
    const agent = new Agent({
      toolExecution: "sequential",
      streamFn,
      initialState: {
        tools: [
          {
            ...makeTool("write"),
            async execute() {
              writeSettled = true;
              throw uncertain;
            },
          },
          { ...makeTool("tail"), execute: executeTail },
        ],
      },
    });
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
    const outcome = await agent
      .prompt("Run the write before its publication")
      .catch((error: unknown) => error);
    expectFailureGraph(outcome, uncertain, publicationFailure);
    expect(writeSettled && publicationFailed).toBe(true);
    expect(executeTail).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledOnce();
    expect(agent.state.isStreaming).toBe(false);
  },
);

it("retains returned and rejected failures from separate streamed tool batches", async () => {
  const primary = new SqliteTranscriptMutationConflictError("synthetic-streamed-session");
  const uncertain = new SqliteWorkerError("Synthetic unsettled result", "outcome-unknown");
  const siblingStarted = Promise.withResolvers<void>();
  const primaryFailed = Promise.withResolvers<void>();
  let siblingSettled = false;
  let publicationFailed = false;
  const calls = [makeCall("first"), makeCall("sibling")].map((call) =>
    Object.assign(call, { async: true as const }),
  );
  const streamFn = vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    startToolCalls(stream, calls);
    finishMessageStream(stream, makeAssistantMessage(calls));
    return stream;
  });
  const agent = new Agent({
    toolExecution: "parallel",
    streamFn,
    initialState: {
      tools: [
        {
          ...makeTool("first"),
          async execute() {
            await siblingStarted.promise;
            primaryFailed.resolve();
            throw primary;
          },
        },
        {
          ...makeTool("sibling"),
          async execute() {
            siblingStarted.resolve();
            await primaryFailed.promise;
            await nextTurn();
            siblingSettled = true;
            return { content: [], details: {} };
          },
        },
      ],
    },
  });
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
  const outcome = await agent.prompt("Run both streamed tools").catch((error: unknown) => error);
  expectFailureGraph(outcome, primary, uncertain);
  expect(siblingSettled && publicationFailed).toBe(true);
  expect(streamFn).toHaveBeenCalledOnce();
  expect(agent.state.isStreaming).toBe(false);
});

it("releases an admitted sequential async batch when its predecessor fails locally", async () => {
  const uncertain = new SqliteWorkerError("Synthetic predecessor failure", "outcome-unknown");
  const waitingAdmitted = Promise.withResolvers<void>();
  const executeWaiting = vi.fn(async () => ({ content: [], details: {} }));
  const releaseWaiting = vi.fn();
  const beforeCalls: string[] = [];
  const calls = [makeCall("first"), makeCall("waiting")].map((call) =>
    Object.assign(call, { async: true as const }),
  );
  const streamFn = vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    startToolCalls(stream, calls);
    finishMessageStream(stream, makeAssistantMessage(calls));
    return stream;
  });
  const agent = new Agent({
    toolExecution: "parallel",
    streamFn,
    beforeToolCall: async ({ toolCall }) => {
      beforeCalls.push(toolCall.name);
    },
    initialState: {
      tools: [
        {
          ...makeTool("first"),
          async execute() {
            await waitingAdmitted.promise;
            await nextTurn();
            throw uncertain;
          },
        },
        { ...makeTool("waiting"), executionMode: "sequential", execute: executeWaiting },
      ],
    },
  });
  setInternalBeforeToolBatch(agent, async ({ calls: admittedCalls }) => {
    if (admittedCalls.some(({ toolCall }) => toolCall.name === "waiting")) {
      waitingAdmitted.resolve();
      return attachInternalToolBatchLifecycle({}, { releaseSkippedCalls: releaseWaiting });
    }
    return undefined;
  });
  const outcome = await agent.prompt("Run both streamed tools").catch((error: unknown) => error);
  expectFailureGraph(outcome, uncertain);
  expect(releaseWaiting).toHaveBeenCalledExactlyOnceWith(["waiting"]);
  expect(beforeCalls).toEqual(["first"]);
  expect(executeWaiting).not.toHaveBeenCalled();
  expect(streamFn).toHaveBeenCalledOnce();
  expect(agent.state.isStreaming).toBe(false);
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
    const streamFn = vi.fn(createTurnSequenceStream([[makeCall("first"), makeCall("sibling")]]));
    const agent = new Agent({
      toolExecution: "parallel",
      streamFn,
      initialState: {
        tools: [
          {
            ...makeTool("first"),
            async execute() {
              await guardEntered.promise;
              throw primary;
            },
          },
          sibling,
        ],
      },
    });
    const siblingEnds: unknown[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "sibling") {
        siblingEnds.push(event.result);
      }
    });
    const outcome = await agent.prompt("Run both guards").catch((error: unknown) => error);
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
    expect(streamFn).toHaveBeenCalledOnce();
    expect(agent.state.isStreaming).toBe(false);
  },
);

it("keeps pre-start publication failure primary when admission release also fails", async () => {
  const uncertain = new SqliteWorkerError("Synthetic publication failure", "outcome-unknown");
  const cleanup = new Error("Synthetic admission release failure");
  const tool = attachInternalToolExecutionPreparer(makeTool("prestart"), async () => ({
    kind: "ready",
    args: {},
    execute: async () => ({ content: [], details: {} }),
    dispose() {},
  }));
  const agent = new Agent({
    toolExecution: "parallel",
    streamFn: createTurnSequenceStream([[makeCall("prestart")]]),
    initialState: { tools: [tool] },
  });
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
  const outcome = await agent
    .prompt("Publish the prepared result")
    .catch((error: unknown) => error);
  expectFailureGraph(outcome, uncertain, cleanup);
  expect(outcome).toMatchObject({ cause: uncertain });
  expect(agent.state.isStreaming).toBe(false);
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
    const tool = attachInternalToolExecutionPreparer(
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
    const agent = new Agent({
      streamFn: createTurnSequenceStream([[makeCall("progress")]]),
      initialState: { tools: [tool] },
    });
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
    const outcome = await agent
      .prompt("Run the progress-producing tool")
      .catch((error: unknown) => error);
    expectFailureGraph(outcome, primary, publication, latePublication, cleanup);
    expect(lateSettled).toBe(true);
    expect(agent.state.isStreaming).toBe(false);
  },
);

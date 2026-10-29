import { expect, it, vi } from "vitest";
import {
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import {
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
} from "../../packages/agent-core/src/internal-hooks.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { wrapToolDefinition } from "../agents/sessions/tools/tool-definition-wrapper.js";
import { decodePostgresError } from "../infra/postgres-sync/protocol.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { Agent, type AgentEvent } from "./agent-core.js";

const admissionFailurePhases = [
  "prepare-throw",
  "prepare-result",
  "started-sequential",
  "result-persistence",
  "aborted-settlement",
] as const;

it.each(admissionFailurePhases)(
  "releases unstarted admission after a local failure at %s",
  async (phase) => {
    const failure = new SqliteWorkerError("Synthetic unsettled write", "outcome-unknown");
    const executePrefix = vi.fn(async () => ({ content: [], details: {} }));
    const executeTail = vi.fn(async () => ({ content: [], details: {} }));
    const failing = makeTool("failing");
    const started = phase === "started-sequential" || phase === "result-persistence";
    if (phase === "started-sequential") {
      failing.execute = async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        throw failure;
      };
    } else if (phase === "prepare-throw" || phase === "prepare-result") {
      attachInternalToolExecutionPreparer(failing, async () => {
        if (phase === "prepare-throw") {
          throw failure;
        }
        return { kind: "immediate", outcome: { kind: "error", error: failure }, dispose() {} };
      });
    }
    const streamFn = vi.fn(
      createTurnSequenceStream([
        [makeCall("prefix", "prefix"), makeCall("failing", "failing"), makeCall("tail", "tail")],
      ]),
    );
    const agent = new Agent({
      toolExecution: started ? "sequential" : "parallel",
      initialState: {
        tools: [
          { ...makeTool("prefix"), execute: executePrefix },
          failing,
          { ...makeTool("tail"), execute: executeTail },
        ],
      },
      streamFn,
    });
    agent.subscribe((event) => {
      if (phase === "aborted-settlement") {
        if (event.type === "tool_execution_start" && event.toolCallId === "failing") {
          agent.abort();
        }
        if (event.type === "tool_execution_end" && event.toolCallId === "prefix") {
          throw failure;
        }
      }
      if (
        phase === "result-persistence" &&
        event.type === "message_end" &&
        event.message.role === "toolResult" &&
        event.message.toolCallId === "failing"
      ) {
        throw failure;
      }
    });
    const admitted = new Set<string>();
    const releaseSkippedCalls = vi.fn((ids: readonly string[]) => {
      for (const id of ids) {
        admitted.delete(id);
      }
    });
    setInternalBeforeToolBatch(agent, async ({ calls }) => {
      for (const call of calls) {
        admitted.add(call.toolCall.id);
      }
      return attachInternalToolBatchLifecycle(
        {},
        {
          commitReadyCalls(readyCalls) {
            for (const call of readyCalls) {
              admitted.delete(call.toolCallId);
            }
          },
          releaseSkippedCalls,
        },
      );
    });

    await expect(agent.prompt("Run the admitted tools")).rejects.toBe(failure);
    expect(streamFn).toHaveBeenCalledOnce();
    expect(executePrefix).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(executeTail).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(
      started ? ["tail"] : ["prefix", "failing", "tail"],
    );
    expect(admitted.size).toBe(0);
    expect(agent.state.isStreaming).toBe(false);
  },
);

it.each(["code", "nested errors"])(
  "keeps unreadable %s diagnostics from ending an ordinary tool turn",
  async (field) => {
    const failure = new AggregateError([], "Synthetic tool failure");
    const unsafe = () => {
      throw new Error("Diagnostic access must not replace the original tool failure");
    };
    if (field === "code") {
      Object.defineProperty(failure, "code", { get: unsafe });
    } else {
      Object.defineProperty(failure.errors, Symbol.iterator, { get: unsafe });
    }
    const streamFn = vi.fn(
      createTurnSequenceStream([
        [makeCall("failing", "failing")],
        [{ type: "text", text: "Continued after the tool failure" }],
      ]),
    );
    const agent = new Agent({
      streamFn,
      initialState: {
        tools: [
          {
            ...makeTool("failing"),
            async execute() {
              throw failure;
            },
          },
        ],
      },
    });
    await expect(agent.prompt("Run the synthetic tool")).resolves.toBeUndefined();
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(agent.state.errorMessage).toBeUndefined();
    expect(agent.state.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "failing", isError: true }),
    );
  },
);

const uncertainWrite = () => new SqliteWorkerError("Unconfirmed write", "outcome-unknown");
const diskFailure = Object.assign(new Error("Disk full"), { code: "SQLITE_FULL" });
const unreadableAggregate = new AggregateError([new Error("Sibling"), uncertainWrite()], "Failure");
Object.defineProperty(unreadableAggregate.errors, Symbol.iterator, {
  get() {
    throw new Error("Unreadable diagnostic");
  },
});
it.each([
  ["unknown outcome", uncertainWrite(), true],
  [
    "database cancellation",
    decodePostgresError({ name: "error", code: "57014", message: "Cancelled" }),
    true,
  ],
  [
    "disk failure with uncertain cleanup",
    new AggregateError([diskFailure, uncertainWrite()], "Cleanup", { cause: diskFailure }),
    true,
  ],
  ["unreadable aggregate diagnostics", unreadableAggregate, true],
  ["ordinary failure", new Error("Tool failed"), false],
  ["SQLite contention", Object.assign(new Error("Busy"), { code: "SQLITE_BUSY" }), false],
  ["ordinary AbortError", Object.assign(new Error("Aborted"), { name: "AbortError" }), false],
] as const)("settles accepted tools before reporting %s", async (_name, failure, local) => {
  const siblingStarted = Promise.withResolvers<void>();
  const failureThrown = Promise.withResolvers<void>();
  const releaseSibling = Promise.withResolvers<void>();
  let siblingSettled = false;
  const streamFn = vi.fn(
    createTurnSequenceStream([
      [makeCall("failing", "fail"), makeCall("sibling", "hold")],
      [{ type: "text", text: "Continued" }],
    ]),
  );
  const agent = new Agent({
    initialState: {
      tools: toToolDefinitions([
        {
          ...makeTool("failing"),
          async execute() {
            await siblingStarted.promise;
            failureThrown.resolve();
            throw failure;
          },
        },
        {
          ...makeTool("sibling"),
          async execute() {
            siblingStarted.resolve();
            await releaseSibling.promise;
            siblingSettled = true;
            return { content: [{ type: "text", text: "Completed" }], details: {} };
          },
        },
      ]).map((definition) => wrapToolDefinition(definition)),
    },
    streamFn,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  const pending = agent.prompt("Run the synthetic tools");
  void pending.catch(() => {});
  try {
    await failureThrown.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(agent.state.isStreaming).toBe(true);
    expect(siblingSettled).toBe(false);
  } finally {
    releaseSibling.resolve();
    await pending.catch(() => {});
  }
  if (local) {
    await expect(pending).rejects.toBe(failure);
  } else {
    await expect(pending).resolves.toBeUndefined();
  }
  expect(siblingSettled).toBe(true);
  expect(agent.state.isStreaming).toBe(false);
  expect(streamFn).toHaveBeenCalledTimes(local ? 1 : 2);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "message_end",
      message: expect.objectContaining({ role: "toolResult", toolCallId: "hold" }),
    }),
  );
});

it.each([
  [new SqliteWorkerError("Synthetic unacknowledged write", "outcome-unknown"), "context"],
  [
    decodePostgresError({ name: "error", code: "57014", message: "Synthetic cancellation" }),
    "context",
  ],
  ...[
    "Session transcript anchor was not returned: 00000000-0000-4000-8000-000000000101",
    "Session transcript changed during context read",
    "session writer claim changed before transcript persistence",
  ].map((message) => [new Error(message), "user-persistence"] as const),
] as const)(
  "preserves local failure %s at %s without a terminal-error append",
  async (failure, phase) => {
    const streamFn = vi.fn(createTurnSequenceStream([[]]));
    const agent = new Agent({
      streamFn,
      transformContext: async (messages) => {
        if (phase === "context") {
          throw failure;
        }
        return messages;
      },
    });
    const events: AgentEvent[] = [];
    let terminalErrorWrites = 0;
    agent.subscribe((event) => {
      events.push(event);
      if (phase === "user-persistence" && event.type === "message_end") {
        if (event.message.role === "user") {
          throw failure;
        }
        if (event.message.role === "assistant" && event.message.stopReason === "error") {
          terminalErrorWrites++;
          throw new Error("Synthetic obsolete writer refuses terminal error");
        }
      }
    });
    await expect(agent.prompt("Synthetic turn")).rejects.toBe(failure);
    expect(streamFn).not.toHaveBeenCalled();
    expect(terminalErrorWrites).toBe(0);
    expect(agent.state.isStreaming).toBe(false);
    expect(
      events.some((event) => event.type === "message_end" && event.message.role === "assistant"),
    ).toBe(false);
  },
);

it.each(["caller", "before-provider", "after-provider-abort"] as const)(
  "preserves the %s abort contract",
  async (phase) => {
    const local = phase !== "caller";
    const failure = local
      ? new SqliteWorkerError("Synthetic lost connection", "outcome-unknown")
      : Object.assign(new Error("Synthetic user cancellation"), { name: "AbortError" });
    const streamFn = vi.fn(() => {
      if (phase !== "after-provider-abort") {
        throw new Error("Unexpected provider request");
      }
      const stream = createAssistantMessageEventStream();
      const message = { ...makeAssistantMessage([]), stopReason: "aborted" as const };
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end();
      return stream;
    });
    const agent = new Agent({ streamFn });
    agent.subscribe((event) => {
      if (
        (phase !== "after-provider-abort" && event.type === "turn_start") ||
        (phase === "after-provider-abort" &&
          event.type === "message_end" &&
          event.message.role === "assistant")
      ) {
        agent.abort(failure);
      }
    });
    const pending = agent.prompt("Synthetic abort");
    if (local) {
      await expect(pending).rejects.toBe(failure);
    } else {
      await expect(pending).resolves.toBeUndefined();
      expect(agent.state.messages).toContainEqual(
        expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
      );
    }
    expect(streamFn).toHaveBeenCalledTimes(phase === "after-provider-abort" ? 1 : 0);
    expect(agent.state.isStreaming).toBe(false);
  },
);

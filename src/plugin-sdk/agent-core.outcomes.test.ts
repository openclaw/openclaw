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

it.each([
  {
    name: "unknown outcome",
    failure: new SqliteWorkerError("Synthetic unacknowledged write", "outcome-unknown"),
    local: true,
  },
  {
    name: "database cancellation",
    failure: decodePostgresError({
      name: "error",
      code: "57014",
      message: "Synthetic cancellation",
    }),
    local: true,
  },
  {
    name: "primary disk failure with uncertain cleanup",
    failure: (() => {
      const primary = Object.assign(new Error("Synthetic disk failure"), { code: "SQLITE_FULL" });
      return new AggregateError(
        [primary, new SqliteWorkerError("Synthetic unconfirmed cleanup", "outcome-unknown")],
        "Synthetic operation and cleanup failure",
        { cause: primary },
      );
    })(),
    local: true,
  },
  {
    name: "unknown outcome with unreadable aggregate diagnostics",
    failure: (() => {
      const failure = new AggregateError(
        [
          new Error("Synthetic sibling"),
          new SqliteWorkerError("Unconfirmed write", "outcome-unknown"),
        ],
        "Synthetic operation failure",
      );
      Object.defineProperty(failure.errors, Symbol.iterator, {
        get() {
          throw new Error("Diagnostic access must not replace the original tool failure");
        },
      });
      return failure;
    })(),
    local: true,
  },
  { name: "ordinary tool failure", failure: new Error("Synthetic tool failure"), local: false },
  {
    name: "ordinary SQLite tool contention",
    failure: Object.assign(new Error("Synthetic plugin database contention"), {
      code: "SQLITE_BUSY",
    }),
    local: false,
  },
  {
    name: "ordinary AbortError tool failure",
    failure: Object.assign(new Error("Synthetic tool abort"), { name: "AbortError" }),
    local: false,
  },
])("settles accepted tools before reporting $name", async ({ failure, local }) => {
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

it("preserves ordinary caller abort behavior", async () => {
  const reason = Object.assign(new Error("Synthetic user cancellation"), { name: "AbortError" });
  const agent = new Agent({
    streamFn: vi.fn(() => {
      throw new Error("Unexpected provider request");
    }),
  });
  agent.subscribe((event) => {
    if (event.type === "turn_start") {
      agent.abort(reason);
    }
  });
  await expect(agent.prompt("Synthetic cancelled turn")).resolves.toBeUndefined();
  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.messages).toContainEqual(
    expect.objectContaining({
      role: "assistant",
      stopReason: "aborted",
    }),
  );
});

it.each([
  new SqliteWorkerError("Synthetic unacknowledged write", "outcome-unknown"),
  decodePostgresError({ name: "error", code: "57014", message: "Synthetic cancellation" }),
])("retains local database failures through the agent loop", async (failure) => {
  const agent = new Agent({
    transformContext: async () => {
      throw failure;
    },
    streamFn: vi.fn(() => {
      throw new Error("Unexpected provider request");
    }),
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  await expect(agent.prompt("Synthetic turn")).rejects.toBe(failure);
  expect(agent.state.isStreaming).toBe(false);
  expect(
    events.some((event) => event.type === "message_end" && event.message.role === "assistant"),
  ).toBe(false);
});

it.each(["before-provider", "after-provider-abort"] as const)(
  "retains a local abort reason %s",
  async (phase) => {
    const failure = new SqliteWorkerError("Synthetic lost connection", "outcome-unknown");
    const agent = new Agent({
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        const message = { ...makeAssistantMessage([]), stopReason: "aborted" as const };
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
        return stream;
      },
    });
    agent.subscribe((event) => {
      if (
        (phase === "before-provider" && event.type === "turn_start") ||
        (phase === "after-provider-abort" &&
          event.type === "message_end" &&
          event.message.role === "assistant")
      ) {
        agent.abort(failure);
      }
    });
    await expect(agent.prompt("Synthetic abort")).rejects.toBe(failure);
    expect(agent.state.isStreaming).toBe(false);
  },
);

import type {
  AssistantMessage,
  AssistantMessageEventStreamLike,
  Model,
  StreamFn,
} from "@openclaw/llm-core";
import { expect, it, vi } from "vitest";
import { streamAgentResponse } from "../../packages/agent-core/src/agent-stream-response.js";
import { generateBranchSummary } from "../../packages/agent-core/src/harness/compaction/branch-summarization.js";
import { generateSummary } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { wrapAnthropicStreamWithRecovery } from "../agents/embedded-agent-runner/thinking.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
} from "../agents/sessions/model-registry-runtime.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { ZERO_USAGE_FIXTURE } from "../agents/test-helpers/usage-fixtures.js";
import { openClawAgentCoreRuntime } from "../plugin-sdk/agent-core.js";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  chunks,
  createTestInstance,
  drainTimeout,
  expectUnavailable,
  throwing,
  trackCompletion,
} from "./plugin-instance.test-support.js";

const model: Model = makeProviderModelFixture({
  id: "consumer-fixture",
  name: "Consumer fixture",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  contextWindow: 8000,
  maxTokens: 1000,
});
const user = { role: "user" as const, content: "Summarize this synthetic turn.", timestamp: 1 };
const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Synthetic summary" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 2,
  usage: { ...ZERO_USAGE_FIXTURE, input: 1, output: 1, totalTokens: 2 },
};
const config = { model, convertToLlm: () => [user] };
const noTools = async () => ({
  messages: [],
  terminalToolCallIds: [],
  steeringMessages: [],
  terminate: false,
  terminateRun: false,
});

async function consume(kind: "agent" | "summary" | "branch" | "model-summary", streamFn: StreamFn) {
  const owner = {};
  if (kind === "model-summary") {
    initializeModelRegistryRuntime(owner);
  }
  const runtime =
    kind === "model-summary" ? getModelRegistryRuntime(owner).llmRuntime : openClawAgentCoreRuntime;
  if (kind === "agent") {
    const result = await streamAgentResponse(
      { systemPrompt: "", messages: [user] },
      config,
      undefined,
      () => {},
      [],
      noTools,
      (value) => value,
      streamFn,
      runtime,
    );
    return result.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  const result =
    kind !== "branch"
      ? await generateSummary(
          [user],
          model,
          1000,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          streamFn,
          runtime,
        )
      : await generateBranchSummary(
          [
            {
              type: "message",
              id: "synthetic-entry",
              parentId: null,
              timestamp: "2026-09-06T00:00:00Z",
              message: user,
            },
          ],
          {
            model,
            apiKey: "synthetic",
            signal: new AbortController().signal,
            streamFn,
            runtime,
          },
        );
  if (!result.ok) {
    throw result.error;
  }
  return typeof result.value === "string" ? result.value : result.value.summary;
}

it.each([
  { mode: "result", released: false },
  { mode: "result", released: true },
  { mode: "callback", released: false },
] as const)(
  "retains $mode call authority through retirement (released: $released)",
  async ({ mode, released }) => {
    vi.useFakeTimers();
    const instance = new PluginInstance("retained-call");
    const consumer = instance.retainConsumer();
    const finish = createDeferredCore<string>();
    const entered = createDeferredCore();
    const helper = instance.wrap(() => "original-owner");
    const invokeCallback = instance.wrap(
      async (callback: () => Promise<string>) => await callback(),
    );
    const call =
      mode === "result"
        ? instance.wrap(() => finish.promise)
        : () =>
            invokeCallback(async () => {
              entered.resolve();
              await finish.promise;
              return helper();
            });
    const pending = consumer.run(call);
    void pending.catch(() => {});
    if (mode === "callback") {
      await entered.promise;
    }
    const retirement = instance.dispose();
    let settlement: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(mode === "callback" ? 4_999 : 5_000);
      if (mode === "result") {
        settlement = drainTimeout((await retirement).errors[0]).settled;
        expectUnavailable(() => instance.run(() => "fresh"));
      }
      if (released) {
        consumer.release();
      }
      finish.resolve("completed");
      if (mode === "callback") {
        await vi.advanceTimersByTimeAsync(0);
      }
      if (released) {
        await expect(pending).rejects.toBeInstanceOf(PluginInstanceUnavailableError);
      } else {
        await expect(pending).resolves.toBe(mode === "result" ? "completed" : "original-owner");
      }
      if (mode === "callback") {
        expectUnavailable(helper);
      }
      consumer.release();
      expect(() => consumer.run(call)).toThrow("consumer is closed");
      await settlement;
    } finally {
      finish.resolve("completed");
      consumer.release();
      await Promise.allSettled([pending, retirement, settlement]);
      vi.useRealTimers();
    }
  },
);

it.each(["host", "descendant"])("waits for retained %s work to settle", async (kind) => {
  const instance = new PluginInstance("retained-work");
  const parent = kind === "descendant" ? instance.retainConsumer() : undefined;
  const release = parent ? () => parent.release() : instance.retainWork();
  const child = parent?.run(() => instance.retainConsumer());
  const settled = vi.fn();
  const drained = instance.waitForRetainedWork(new AbortController().signal).then(settled);
  if (child) {
    release();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.run(() => "finished")).toBe("finished");
    child.release();
  } else {
    await expect(instance.dispose()).resolves.toEqual({ errors: [] });
    expect(settled).not.toHaveBeenCalled();
    release();
    release();
  }
  await drained;
  expect(settled).toHaveBeenCalledOnce();
  await instance.dispose();
  expectUnavailable(() => instance.run(() => "unavailable"));
});

it("admits an async stream factory through recovery before retirement can finish its handoff", async () => {
  const instance = new PluginInstance("async-consumer");
  const factoryStarted = createDeferredCore();
  const releaseFactory = createDeferredCore();
  const source: AssistantMessageEventStreamLike = {
    [Symbol.asyncIterator]: () => chunks({ type: "start" as const, partial: message }),
    result: async () => message,
  };
  const factory = instance.wrap(async () => {
    factoryStarted.resolve();
    await releaseFactory.promise;
    return source;
  });
  const stream = wrapAnthropicStreamWithRecovery(factory, { id: "async-factory-fixture" });
  const output = consume("summary", stream);
  void output.catch(() => {});
  await factoryStarted.promise;
  const closing = instance.dispose();
  try {
    releaseFactory.resolve();
    await expect(output).resolves.toBe("Synthetic summary");
    await closing;
  } finally {
    releaseFactory.resolve();
    await output;
    await closing;
  }
});

it.each(["agent", "branch", "model-summary"] as const)(
  "keeps %s iteration and decorated terminal work in one admission during disposal",
  async (kind) => {
    const instance = new PluginInstance("consumer-fixture");
    const iteratorFinishing = createDeferredCore();
    const finishIterator = createDeferredCore();
    const terminalStarted = createDeferredCore();
    const terminal = createDeferredCore();
    const events: string[] = [];
    let closing: ReturnType<PluginInstance["dispose"]> | undefined;
    const source: AssistantMessageEventStreamLike = {
      async *[Symbol.asyncIterator]() {
        events.push("iterate");
        yield { type: "start", partial: message };
        iteratorFinishing.resolve();
        await finishIterator.promise;
        events.push("iteration-ended");
      },
      async result() {
        events.push("result-started");
        terminalStarted.resolve();
        await terminal.promise;
        events.push("result-ended");
        return message;
      },
    };
    const output = consume(
      kind,
      instance.wrap(() => source),
    );
    void output.catch(() => {});
    try {
      await Promise.race([iteratorFinishing.promise, output]);
      const retirement = trackCompletion(instance.dispose());
      closing = retirement.promise;
      void closing.catch(() => {});
      finishIterator.resolve();
      await Promise.race([terminalStarted.promise, output]);
      expect(events).toEqual(["iterate", "iteration-ended", "result-started"]);
      expect(retirement.done).toBe(false);
      terminal.resolve();
      await expect(output).resolves.toContain("Synthetic summary");
      await closing;
      expect(retirement.done).toBe(true);
    } finally {
      finishIterator.resolve();
      terminal.resolve();
      await output;
      await (closing ?? instance.dispose());
    }
  },
);

it("aborts an error response before invoking its decorated result hook", async () => {
  const instance = createTestInstance("terminal-order");
  const failure = { ...message, stopReason: "error" as const, errorMessage: "synthetic failure" };
  let signal: AbortSignal | undefined;
  const result = vi.fn(async () => {
    expect(signal?.aborted).toBe(true);
    return failure;
  });
  const stream: StreamFn = instance.wrap((_model, _context, options) => {
    signal = options?.signal;
    return {
      [Symbol.asyncIterator]: () =>
        chunks({ type: "error" as const, reason: "error" as const, error: failure }),
      result,
    };
  });
  await consume("agent", stream);
  expect(result).toHaveBeenCalledOnce();
});

it("rejects consumption after the exact stream owner has disposed", async () => {
  const instance = new PluginInstance("late-consumer");
  const iterator = vi.fn(() => chunks({ type: "start" as const, partial: message }));
  const result = vi.fn(async () => message);
  const stream = instance.wrap({ [Symbol.asyncIterator]: iterator, result });
  await instance.dispose();
  await expect(consume("summary", () => stream)).rejects.toThrow(/reloaded|disabled|retiring/);
  expect(iterator).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});

it("keeps retained consumers separate from ordinary drain when cleanup rejects", async () => {
  vi.useFakeTimers();
  const instance = new PluginInstance("retained-consumer");
  const failure = new Error("retained owner cleanup failed");
  const cleanup = vi.fn(throwing(failure));
  instance.lifecycle.onDispose(cleanup);
  const helper = instance.wrap(() => "original-owner");
  const first = instance.retainConsumer();
  const second = instance.retainConsumer();
  const continueFirst = createDeferredCore();
  let closing: ReturnType<PluginInstance["dispose"]> | undefined;
  try {
    await expect(instance.drain()).resolves.toEqual({ errors: [] });
    expectUnavailable(() => helper());
    closing = instance.dispose();
    const retirement = trackCompletion(closing);
    expect(instance.dispose()).toBe(closing);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(retirement.done).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    const stale = first.run(async () => {
      await continueFirst.promise;
      return helper();
    });
    first.release();
    continueFirst.resolve();
    await expect(stale).rejects.toThrow("reloaded or disabled");
    expect(() => first.run(helper)).toThrow("consumer is closed");
    expect(second.run(helper)).toBe("original-owner");
    second.release();
    await expect(closing).resolves.toEqual({ errors: [failure] });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(() => instance.retainConsumer()).toThrow("retiring");
    expect(() => second.run(helper)).toThrow("consumer is closed");
  } finally {
    continueFirst.resolve();
    first.release();
    second.release();
    await (closing ?? instance.dispose());
    vi.useRealTimers();
  }
});

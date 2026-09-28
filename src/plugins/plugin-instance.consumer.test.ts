import type {
  AssistantMessage,
  AssistantMessageEventStreamLike,
  Model,
  StreamFn,
} from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { streamAgentResponse } from "../../packages/agent-core/src/agent-stream-response.js";
import { generateBranchSummary } from "../../packages/agent-core/src/harness/compaction/branch-summarization.js";
import { generateSummary } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { wrapAnthropicStreamWithRecovery } from "../agents/embedded-agent-runner/thinking.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
} from "../agents/sessions/model-registry-runtime.js";
import { openClawAgentCoreRuntime } from "../plugin-sdk/agent-core.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  PluginInstanceDrainTimeoutError,
  PluginInstanceUnavailableError,
} from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";

const model: Model = {
  id: "consumer-fixture",
  name: "Consumer fixture",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 1000,
};
const user = { role: "user" as const, content: "Summarize this synthetic turn.", timestamp: 1 };
const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Synthetic summary" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 2,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const config = { model, convertToLlm: () => [user] };
const noTools = async () => ({
  messages: [],
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

describe("plugin stream consumer admission", () => {
  it.each([false, true])(
    "rechecks retained authority for results after forced retirement (released: %s)",
    async (released) => {
      vi.useFakeTimers();
      const instance = new PluginInstance("retained-result");
      const consumer = instance.retainConsumer();
      const finish = createDeferredCore<string>();
      const operation = instance.wrap(() => finish.promise);
      const pending = consumer.run(operation);
      void pending.catch(() => {});
      const retirement = instance.dispose();
      let settlement: Promise<void> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        const timeout = (await retirement).errors[0];
        expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
        if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
          throw new Error("Expected retained consumer retirement deadline");
        }
        settlement = timeout.settled;
        expect(() => instance.run(() => "fresh")).toThrow("reloaded or disabled");
        if (released) {
          consumer.release();
        }
        finish.resolve("completed");
        if (released) {
          await expect(pending).rejects.toBeInstanceOf(PluginInstanceUnavailableError);
        } else {
          await expect(pending).resolves.toBe("completed");
          consumer.release();
        }
        expect(() => consumer.run(operation)).toThrow("consumer is closed");
        await settlement;
      } finally {
        finish.resolve("completed");
        consumer.release();
        await Promise.allSettled([pending, retirement, settlement]);
        vi.useRealTimers();
      }
    },
  );

  it("fences new retained admission while replacing an idle donor and releases only its own reservation", async () => {
    const instance = new PluginInstance("idle-donor");
    const custody = instance.retainConsumer(undefined, undefined, "custody");
    const release = instance.reserveReplacement();
    try {
      expect(() => instance.retainConsumer()).toThrow("retiring");
      expect(() => custody.run(() => instance.retainConsumer())).toThrow("retiring");
      expect(() => instance.retainWork()).toThrow("replacement is in progress");
      expect(() => instance.reserveReplacement()).toThrow("replacement is in progress");
      release();
      const releaseNext = instance.reserveReplacement();
      release();
      expect(() => instance.retainWork()).toThrow("replacement is in progress");
      releaseNext();
      const work = instance.retainConsumer();
      expect(work.run(() => "still callable")).toBe("still callable");
      work.release();
    } finally {
      release();
      custody.release();
      await instance.dispose();
    }
  });

  it("keeps finite host work visible to replacement without making disposal wait on itself", async () => {
    const instance = new PluginInstance("host-work");
    const release = instance.retainWork();
    const replacement = instance.reserveReplacement();
    const settled = vi.fn();
    const drained = instance.waitForRetainedWork(new AbortController().signal).then(settled);
    await expect(instance.dispose()).resolves.toEqual({ errors: [] });
    expect(settled).not.toHaveBeenCalled();
    release();
    release();
    await drained;
    expect(settled).toHaveBeenCalledOnce();
    replacement();
    expect(() => instance.run(() => "unavailable")).toThrow("reloaded or disabled");
  });

  it("drains descendants of admitted work without admitting new work from idle custody", async () => {
    const instance = new PluginInstance("work-descendants");
    const work = instance.retainConsumer();
    const custody = instance.retainConsumer(undefined, undefined, "custody");
    const replacement = instance.reserveReplacement();
    const child = work.run(() => instance.retainConsumer());
    const settled = vi.fn();
    const drained = instance.waitForRetainedWork(new AbortController().signal).then(settled);
    expect(() => custody.run(() => instance.retainConsumer())).toThrow("retiring");
    work.release();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.run(() => "finished")).toBe("finished");
    child.release();
    await drained;
    replacement();
    custody.release();
    await instance.dispose();
  });

  it.each(["direct", "thinking"] as const)(
    "admits an async stream factory through %s before retirement can finish its handoff",
    async (wrapper) => {
      const instance = new PluginInstance("async-consumer");
      const factoryStarted = createDeferredCore();
      const releaseFactory = createDeferredCore();
      const source: AssistantMessageEventStreamLike = {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
        },
        result: async () => message,
      };
      const factory = instance.wrap(async () => {
        factoryStarted.resolve();
        await releaseFactory.promise;
        return source;
      });
      const stream =
        wrapper === "thinking"
          ? wrapAnthropicStreamWithRecovery(factory, { id: "async-factory-fixture" })
          : factory;
      const output = consume("summary", stream).then(
        (value) => ({ status: "fulfilled", value }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      await factoryStarted.promise;
      const closing = instance.dispose();
      try {
        releaseFactory.resolve();
        expect(await output).toEqual({ status: "fulfilled", value: "Synthetic summary" });
        await closing;
      } finally {
        releaseFactory.resolve();
        await output;
        await closing;
      }
    },
  );

  it.each(["agent", "summary", "branch", "model-summary"] as const)(
    "keeps %s iteration and decorated terminal work in one admission during disposal",
    async (kind) => {
      const instance = new PluginInstance("consumer-fixture");
      const iteratorFinishing = createDeferredCore();
      const finishIterator = createDeferredCore();
      const terminalStarted = createDeferredCore();
      const terminal = createDeferredCore();
      const events: string[] = [];
      let closing: Promise<void> | undefined;
      let closed = false;
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
      ).then(
        (value) => ({ status: "fulfilled", value }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      try {
        await Promise.race([iteratorFinishing.promise, output]);
        closing = instance.dispose().then(() => {
          closed = true;
        });
        void closing.catch(() => {});
        finishIterator.resolve();
        await Promise.race([terminalStarted.promise, output]);
        expect(events).toEqual(["iterate", "iteration-ended", "result-started"]);
        expect(closed).toBe(false);
        terminal.resolve();
        expect(await output).toMatchObject({
          status: "fulfilled",
          value: expect.stringContaining("Synthetic summary"),
        });
        await closing;
        expect(closed).toBe(true);
      } finally {
        finishIterator.resolve();
        terminal.resolve();
        await output;
        await (closing ?? instance.dispose());
      }
    },
  );

  it("aborts an error response before invoking its decorated result hook", async () => {
    const instance = new PluginInstance("terminal-order");
    const failure = { ...message, stopReason: "error" as const, errorMessage: "synthetic failure" };
    let signal: AbortSignal | undefined;
    const result = vi.fn(async () => {
      expect(signal?.aborted).toBe(true);
      return failure;
    });
    const stream: StreamFn = instance.wrap((_model, _context, options) => {
      signal = options?.signal;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "error" as const, reason: "error" as const, error: failure };
        },
        result,
      };
    });
    try {
      await consume("agent", stream);
      expect(result).toHaveBeenCalledOnce();
    } finally {
      await instance.dispose();
    }
  });

  it("rejects consumption after the exact stream owner has disposed", async () => {
    const instance = new PluginInstance("late-consumer");
    const iterator = vi.fn(async function* () {
      yield { type: "start" as const, partial: message };
    });
    const result = vi.fn(async () => message);
    const stream = instance.wrap({ [Symbol.asyncIterator]: iterator, result });
    await instance.dispose();
    await expect(consume("summary", () => stream)).rejects.toThrow(/reloaded|disabled|retiring/);
    expect(iterator).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps retained consumers separate from ordinary drain (cleanup rejects: %s)",
    async (rejectCleanup) => {
      vi.useFakeTimers();
      const instance = new PluginInstance("retained-consumer");
      const failure = new Error("retained owner cleanup failed");
      const cleanup = vi.fn(() => {
        if (rejectCleanup) {
          throw failure;
        }
      });
      instance.lifecycle.onDispose(cleanup);
      const helper = instance.wrap(() => "original-owner");
      const first = instance.retainConsumer();
      const second = instance.retainConsumer();
      const continueFirst = createDeferredCore();
      let closing: ReturnType<PluginInstance["dispose"]> | undefined;
      try {
        await expect(instance.drain()).resolves.toEqual({ errors: [] });
        expect(() => helper()).toThrow("reloaded or disabled");
        let closed = false;
        closing = instance.dispose();
        void closing.then(() => {
          closed = true;
        });
        expect(instance.dispose()).toBe(closing);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(closed).toBe(false);
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
        await expect(closing).resolves.toEqual({ errors: rejectCleanup ? [failure] : [] });
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
    },
  );

  it("keeps wrapped callback continuations in their retained consumer", async () => {
    vi.useFakeTimers();
    const instance = new PluginInstance("nested-consumer");
    const consumer = instance.retainConsumer();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const observed: unknown[] = [];
    const helper = instance.wrap(() => "original-owner");
    const invokeCallback = instance.wrap(
      async (callback: () => Promise<string>) => await callback(),
    );
    const operation = consumer.run(() =>
      invokeCallback(async () => {
        entered.resolve();
        await resume.promise;
        try {
          const value = helper();
          observed.push(value);
          return value;
        } catch (error) {
          observed.push(error);
          throw error;
        }
      }),
    );
    void operation.catch(() => {});
    await entered.promise;
    const closing = instance.dispose();
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      resume.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toEqual(["original-owner"]);
      expect(() => helper()).toThrow("reloaded or disabled");
    } finally {
      consumer.release();
      resume.resolve();
      await Promise.allSettled([operation, closing]);
      vi.useRealTimers();
    }
  });
});

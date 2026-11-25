import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as hostTurn } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createDiagnosticToolExecutionLiveness,
  recordDiagnosticToolExecutionDeadline,
} from "../infra/diagnostic-tool-execution-liveness.js";
import { AsyncContext } from "../shared/async-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { assertCompleteToolResult, runWithToolResultDelivery } from "./tool-result-limits.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  restrictToolSearchCatalog,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  retainToolSearchImplementation,
  runScheduledToolSearchCall,
} from "./tool-search-scheduling.js";
import type { ToolSearchCallOptions, ToolSearchToolContext } from "./tool-search-types.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const config = resolveToolSearchConfig({ tools: { toolSearch: { maxSearchLimit: 50 } } });
type Mode = AnyAgentTool["executionMode"];

it("shares a native carrier across tool settlement, delivery, and liveness", async () => {
  const { ctx, catalogRef } = fixture();
  const entry = catalogRef.current!.entries[0]!;
  const ambient = new AsyncContext<string>(Symbol("tool-caller"));
  const invocation = createDiagnosticToolExecutionLiveness();
  using runs = vi.spyOn(AsyncLocalStorage.prototype, "run");
  using entries = vi.spyOn(AsyncLocalStorage.prototype, "enterWith");
  try {
    await ambient.run("caller", () =>
      runScheduledToolSearchCall({
        ctx,
        entry,
        execute: () =>
          runWithToolResultDelivery(true, () =>
            invocation.run(async () => {
              await Promise.resolve();
              expect(ambient.getStore()).toBe("caller");
              recordDiagnosticToolExecutionDeadline(123);
              expect(invocation.view.deadlineAtMs).toBe(123);
              expect(() => assertCompleteToolResult("complete")).not.toThrow();
            }),
          ),
      }),
    );
    expect(ambient.getStore()).toBeUndefined();
    expect(() => assertCompleteToolResult("complete")).toThrow("Code Mode");
    // Every extra native carrier widens all subsequent work-scope frame copies.
    expect(new Set([...runs.mock.contexts, ...entries.mock.contexts]).size).toBe(1);
  } finally {
    invocation.close();
  }
});

function fixture(
  modes: [Mode, Mode] = ["sequential", "sequential"],
  extra: Partial<ToolSearchToolContext> = {},
) {
  const events: string[] = [];
  const releases: (() => void)[] = [];
  const calls: Promise<unknown>[] = [];
  const catalogRef = createToolSearchCatalogRef();
  const ctx: ToolSearchToolContext = { catalogRef, ...extra };
  const runtime = new ToolSearchRuntime(ctx, config);
  const gate = (name: string, executionMode: Mode) => {
    const [started, release] = [createDeferredCore(), createDeferredCore()];
    releases.push(() => release.resolve());
    const tool: AnyAgentTool = {
      ...createStubTool(name),
      executionMode,
      execute: vi.fn(async () => {
        events.push(name + ":start");
        started.resolve();
        await release.promise;
        events.push(name + ":done");
        return jsonResult({ name });
      }),
    };
    return { tool, started: started.promise, release: () => release.resolve() };
  };
  const [a, b] = [gate("a", modes[0]), gate("b", modes[1])];
  const register = (tools = [a.tool, b.tool]) =>
    registerHeadlessToolSearchCatalog({ catalogRef, tools });
  register();
  const call = (name: string, options: ToolSearchCallOptions = {}, executor = runtime) => {
    const result = executor.call(name, {}, options);
    calls.push(result);
    return result;
  };
  onTestFinished(async () => {
    releases.forEach((release) => release());
    await Promise.allSettled(calls);
    clearToolSearchCatalog(ctx);
  });
  return { a, b, gate, call, register, events, ctx, catalogRef, runtime, releases };
}

it("shares FIFO exclusion across runtimes while allowing the parallel prefix", async () => {
  const h = fixture([undefined, "parallel"]);
  const { a, b, gate, call, register, events } = h;
  const c = gate("c", "sequential"),
    d = gate("d", "parallel"),
    e = gate("e", "sequential");
  register([a.tool, b.tool, c.tool, d.tool, e.tool]);
  const sibling = new ToolSearchRuntime(h.ctx, config);
  const calls = [call("a"), call("b", {}, sibling), call("c"), call("d", {}, sibling), call("e")];
  await Promise.all([a.started, b.started]);
  expect(events).toEqual(["a:start", "b:start"]);
  a.release();
  await calls[0];
  expect(events).not.toContain("c:start");
  b.release();
  await c.started;
  expect(events).toEqual(["a:start", "b:start", "a:done", "b:done", "c:start"]);
  c.release();
  await d.started;
  expect(events).not.toContain("e:start");
  d.release();
  await e.started;
  e.release();
  await Promise.all(calls);
  expect(h.catalogRef.onDispose?.size ?? 0).toBe(0);
});

it.each(["call", "context"] as const)("queued %s cancellation", async (source) => {
  const { a, b, gate, call, register, events, ctx, runtime } = fixture();
  const c = gate("c", "parallel");
  register([a.tool, b.tool, c.tool]);
  const controller = new AbortController();
  const queuedRuntime =
    source === "context"
      ? new ToolSearchRuntime({ ...ctx, abortSignal: controller.signal }, config)
      : runtime;
  const first = call("a");
  await a.started;
  const signal = source === "call" ? controller.signal : new AbortController().signal;
  const queued = call("b", { signal }, queuedRuntime);
  const rejected = expect(queued).rejects.toThrow(/aborted/i);
  const tail = call("c");
  controller.abort();
  await rejected;
  await hostTurn();
  expect(events).toEqual(["a:start"]);
  a.release();
  await c.started;
  c.release();
  await Promise.all([first, tail]);
  expect(b.tool.execute).not.toHaveBeenCalled();
});

it("cancels a disposed generation without blocking a reopened catalog", async () => {
  const { a, b, gate, call, register, ctx, catalogRef } = fixture();
  const fresh = gate("fresh", "sequential");
  const active = call("a");
  await a.started;
  const waiting = call("b");
  const rejected = expect(waiting).rejects.toThrow(/aborted/i);
  clearToolSearchCatalog(ctx);
  await rejected;
  register([fresh.tool]);
  const replacement = call("fresh");
  await fresh.started;
  a.release();
  await active;
  fresh.release();
  await replacement;
  expect(b.tool.execute).not.toHaveBeenCalled();
  expect(catalogRef.onDispose?.size ?? 0).toBe(0);
});

it.each(["remove", "replace", "append"] as const)("rechecks %s targets", async (change) => {
  const { a, b, gate, call, register, catalogRef } = fixture();
  const other = gate("other", "parallel");
  const active = call("a");
  await a.started;
  const queued = call("b");
  const result = change === "append" ? queued : expect(queued).rejects.toThrow(/changed|available/);
  if (change === "remove") {
    restrictToolSearchCatalog({ catalogRef, allowedToolNames: new Set(["a"]) });
  } else {
    register(change === "append" ? [a.tool, b.tool, other.tool] : [a.tool, { ...b.tool }]);
  }
  a.release();
  if (change === "append") {
    await b.started;
    b.release();
  }
  await Promise.all([active, result]);
  expect(b.tool.execute).toHaveBeenCalledTimes(change === "append" ? 1 : 0);
});

it("keeps exclusion until executor acceptance settles", async () => {
  const [accepting, releaseAcceptance] = [createDeferredCore(), createDeferredCore()];
  const { a, b, call, events, releases } = fixture(["sequential", "parallel"], {
    executeTool: async (params) => {
      const result = await params.tool.execute(
        params.toolCallId,
        params.input,
        params.signal,
        params.onUpdate,
        undefined as never,
      );
      if (params.toolName === "a") {
        accepting.resolve();
        await releaseAcceptance.promise;
      }
      return await params.acceptResultBeforeProjection(result);
    },
  });
  releases.push(() => releaseAcceptance.resolve());
  const [first, second] = [call("a"), call("b")];
  await a.started;
  a.release();
  await accepting.promise;
  await hostTurn();
  expect(events).toEqual(["a:start", "a:done"]);
  releaseAcceptance.resolve();
  await b.started;
  b.release();
  await Promise.all([first, second]);
});

it("retains implementation settlement across an async executor continuation", async () => {
  const implementation = createDeferredCore();
  const { a, b, call, releases } = fixture();
  releases.push(() => implementation.resolve());
  a.tool.execute = async () => {
    await Promise.resolve();
    void retainToolSearchImplementation(implementation.promise);
    return jsonResult({ accepted: true });
  };
  const first = call("a");
  const second = call("b");
  await first;
  expect(b.tool.execute).not.toHaveBeenCalled();
  implementation.resolve();
  await b.started;
  b.release();
  await second;
});

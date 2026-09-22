import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

const traces = {
  first: { traceId: "1".repeat(32), spanId: "1".repeat(16) },
  second: { traceId: "2".repeat(32), spanId: "2".repeat(16) },
  waiter: {
    traceId: "3".repeat(32),
    spanId: "3".repeat(16),
    parentSpanId: "4".repeat(16),
    traceFlags: "01",
  },
} satisfies Record<string, DiagnosticTraceContext>;
let clock = 120_000;
let directory: string;
let logFile: string;
let diagnosticsWereEnabled: boolean;

async function records(message: string): Promise<Record<string, unknown>[]> {
  await flushLogger();
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || record.message !== message) {
        return [];
      }
      const fields = Object.values(record).find(
        (value): value is Record<string, unknown> => isRecord(value) && "operationId" in value,
      );
      return [
        {
          ...fields,
          traceId: record.traceId,
          spanId: record.spanId,
          parentSpanId: record.parentSpanId,
          traceFlags: record.traceFlags,
        },
      ];
    });
}

async function advance(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function hold(
  kind: "lifecycle" | "mutation",
  target: { scope: string; identities: string[] },
  trace?: DiagnosticTraceContext,
) {
  const entered = createDeferred();
  const release = createDeferred();
  const params = {
    ...target,
    run: async () => {
      entered.resolve();
      await release.promise;
    },
  };
  const promise = runWithDiagnosticTraceContext(trace, () =>
    kind === "lifecycle"
      ? beginSessionWorkAdmission({
          ...target,
          assertAllowed: params.run,
          revalidateAllowed: () => {},
        }).then((lease) => lease.release())
      : runExclusiveSessionLifecycleMutation(params),
  );
  return { entered: entered.promise, release: release.resolve, promise };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-diagnostics-"));
  logFile = path.join(directory, "runtime.log");
  fs.writeFileSync(logFile, "");
  diagnosticsWereEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  resetLogger();
  setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
  clock += 120_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(async () => {
  await flushLogger();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
  setLoggerOverride(null);
  resetLogger();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("reports the current holder after turnover and preserves the waiter's trace and FIFO order", async () => {
  const target = { scope: "private-store-path", identities: ["private-session-key"] };
  const firstStarted = createDeferred();
  const secondStarted = createDeferred();
  const releaseFirst = createDeferred();
  const releaseSecond = createDeferred();
  const order: string[] = [];
  const first = runWithDiagnosticTraceContext(traces.first, () =>
    runExclusiveSessionLifecycleMutation({
      ...target,
      run: async () => {
        order.push("first");
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    }),
  );
  await firstStarted.promise;
  const second = runWithDiagnosticTraceContext(traces.second, () =>
    runExclusiveSessionLifecycleMutation({
      ...target,
      run: async () => {
        order.push("second");
        secondStarted.resolve();
        await releaseSecond.promise;
      },
    }),
  );
  const waiter = runWithDiagnosticTraceContext(traces.waiter, () =>
    runExclusiveSessionLifecycleMutation({
      ...target,
      run: async () => {
        order.push("waiter");
      },
    }),
  );
  try {
    await advance(500);
    releaseFirst.resolve();
    await secondStarted.promise;
    await advance(500);
    const waiting = await records("session lifecycle queue waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      operationTraceId: traces.waiter.traceId,
      holderTraceId: traces.second.traceId,
      traceId: traces.waiter.traceId,
      parentSpanId: traces.waiter.parentSpanId,
      traceFlags: traces.waiter.traceFlags,
      queueKind: "mutation",
      holderPhase: "run",
      holderObserved: true,
      waitMs: 1_000,
    });
    expect(waiting[0]?.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(waiting)).not.toContain(target.scope);
    expect(JSON.stringify(waiting)).not.toContain(target.identities[0]);
    expect(order).toEqual(["first", "second"]);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.allSettled([first, second, waiter]);
  }
  expect(order).toEqual(["first", "second", "waiter"]);
});

it("distinguishes mutation and lifecycle holders of the same normalized identity", async () => {
  const target = { scope: "namespace-store", identities: ["namespace-session"] };
  const lifecycle = hold("lifecycle", target, traces.first);
  await lifecycle.entered;
  const mutation = hold("mutation", target, traces.second);
  const waiter = hold("mutation", target, traces.waiter);
  try {
    await advance(1_000);
    const waiting = await records("session lifecycle queue waiting");
    expect(waiting).toHaveLength(2);
    expect(waiting).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queueKind: "lifecycle",
          operationTraceId: traces.second.traceId,
          holderTraceId: traces.first.traceId,
          holderPhase: "run",
        }),
        expect.objectContaining({
          queueKind: "mutation",
          operationTraceId: traces.waiter.traceId,
          holderTraceId: traces.second.traceId,
          holderPhase: "activation",
        }),
      ]),
    );
    expect(new Set(waiting.map((record) => record.identityHash)).size).toBe(1);
  } finally {
    lifecycle.release();
    mutation.release();
    waiter.release();
    await Promise.allSettled([lifecycle.promise, mutation.promise, waiter.promise]);
  }
});

it.each([true, false])(
  "preserves an outer holder through reentry when initially enabled=%s",
  async (initiallyEnabled) => {
    const target = { scope: `reentry-store-${initiallyEnabled}`, identities: ["reentry-session"] };
    const outerStarted = createDeferred();
    const beginNested = createDeferred();
    const nestedStarted = createDeferred();
    const releaseNested = createDeferred();
    const nestedDone = createDeferred();
    const releaseOuter = createDeferred();
    setDiagnosticsEnabledForProcess(initiallyEnabled);
    const outer = runWithDiagnosticTraceContext(traces.first, () =>
      runExclusiveSessionLifecycleMutation({
        ...target,
        run: async () => {
          outerStarted.resolve();
          await beginNested.promise;
          await runWithDiagnosticTraceContext(traces.second, () =>
            runExclusiveSessionLifecycleMutation({
              ...target,
              run: async () => {
                nestedStarted.resolve();
                await releaseNested.promise;
              },
            }),
          );
          nestedDone.resolve();
          await releaseOuter.promise;
        },
      }),
    );
    await outerStarted.promise;
    setDiagnosticsEnabledForProcess(true);
    beginNested.resolve();
    await nestedStarted.promise;
    const waiter = hold("mutation", target, traces.waiter);
    try {
      await advance(500);
      releaseNested.resolve();
      await nestedDone.promise;
      await advance(500);
      const waiting = await records("session lifecycle queue waiting");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({
        operationTraceId: traces.waiter.traceId,
        holderObserved: initiallyEnabled,
      });
      expect(waiting[0]?.holderTraceId).toBe(initiallyEnabled ? traces.first.traceId : undefined);
      expect(waiting[0]?.holderTraceId).not.toBe(traces.second.traceId);
    } finally {
      beginNested.resolve();
      releaseNested.resolve();
      releaseOuter.resolve();
      waiter.release();
      await Promise.allSettled([outer, waiter.promise]);
    }
  },
);

it("measures prepare and finalize separately while successors wait for real finalization", async () => {
  const target = { scope: "phase-store", identities: ["phase-session"] };
  const prepareStarted = createDeferred();
  const releasePrepare = createDeferred();
  const finalizeStarted = createDeferred();
  const releaseFinalize = createDeferred();
  const first = runWithDiagnosticTraceContext(traces.first, () =>
    runExclusiveSessionLifecycleMutation({
      ...target,
      prepare: async () => {
        prepareStarted.resolve();
        await releasePrepare.promise;
      },
      run: async () => {
        clock += 30;
      },
      finalize: async () => {
        finalizeStarted.resolve();
        await releaseFinalize.promise;
      },
    }),
  );
  await prepareStarted.promise;
  await advance(200);
  releasePrepare.resolve();
  await finalizeStarted.promise;
  const waiter = hold("mutation", target, traces.waiter);
  try {
    await advance(1_000);
    expect(await records("session lifecycle queue waiting")).toEqual([
      expect.objectContaining({
        operationTraceId: traces.waiter.traceId,
        holderTraceId: traces.first.traceId,
        holderPhase: "finalize",
      }),
    ]);
  } finally {
    releasePrepare.resolve();
    releaseFinalize.resolve();
    waiter.release();
    await Promise.allSettled([first, waiter.promise]);
  }
  const completed = await records("slow session lifecycle operation");
  expect(completed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationTraceId: traces.first.traceId,
        phaseDurationsMs: { prepare: 200, run: 30, finalize: 1_000 },
        mutationQueueWaitMs: 0,
        lifecycleQueueWaitMs: 0,
      }),
      expect.objectContaining({
        operationTraceId: traces.waiter.traceId,
        mutationQueueWaitMs: 1_000,
      }),
    ]),
  );
});

it("retains a partially acquired holder after caller cancellation until its callback unwinds", async () => {
  const scope = "partial-cancellation-store";
  const blocker = hold("lifecycle", { scope, identities: ["b"] }, traces.first);
  await blocker.entered;
  const controller = new AbortController();
  const cancelledRun = vi.fn(async () => {});
  const cancelled = runWithDiagnosticTraceContext(traces.second, () =>
    runExclusiveSessionLifecycleMutation({
      scope,
      identities: ["a", "b"],
      signal: controller.signal,
      run: cancelledRun,
    }),
  );
  await advance(0);
  const error = new Error("cancel queued mutation");
  controller.abort(error);
  await expect(cancelled).rejects.toBe(error);
  const waiter = hold("mutation", { scope, identities: ["a"] }, traces.waiter);
  try {
    await advance(1_000);
    expect(await records("session lifecycle queue waiting")).toEqual([
      expect.objectContaining({
        operationTraceId: traces.waiter.traceId,
        holderTraceId: traces.second.traceId,
        holderPhase: "activation",
        holderSignalAborted: true,
      }),
    ]);
    expect(cancelledRun).not.toHaveBeenCalled();
  } finally {
    blocker.release();
    waiter.release();
    await Promise.allSettled([blocker.promise, cancelled, waiter.promise]);
  }
  await expect(
    runExclusiveSessionLifecycleMutation({
      scope,
      identities: ["a", "b"],
      run: async () => "next",
    }),
  ).resolves.toBe("next");
});

it("stops pending and terminal emissions when diagnostics are disabled without changing results", async () => {
  const target = { scope: "disabled-store", identities: ["disabled-session"] };
  const holder = hold("mutation", target, traces.first);
  await holder.entered;
  const waiter = hold("mutation", target, traces.waiter);
  try {
    setDiagnosticsEnabledForProcess(false);
    await advance(1_000);
  } finally {
    holder.release();
    waiter.release();
    await Promise.all([holder.promise, waiter.promise]);
  }
  expect(await records("session lifecycle queue waiting")).toEqual([]);
  expect(await records("slow session lifecycle operation")).toEqual([]);
  await expect(
    runExclusiveSessionLifecycleMutation({
      ...target,
      run: async () => "disabled-fast-path",
    }),
  ).resolves.toBe("disabled-fast-path");
});

it("bounds holder, timer and log state without exposing private identities or inventing reentrant holders", async () => {
  const holders = Array.from({ length: 128 }, (_, index) =>
    hold("lifecycle", { scope: `bounded-holder-${index}`, identities: ["session"] }),
  );
  await Promise.all(holders.map((holder) => holder.entered));
  const target = { scope: "sensitive-capacity-store", identities: ["sensitive-capacity-session"] };
  const outerStarted = createDeferred();
  const beginNested = createDeferred();
  const nestedStarted = createDeferred();
  const releaseNested = createDeferred();
  const releaseOuter = createDeferred();
  const outer = beginSessionWorkAdmission({
    ...target,
    assertAllowed: async () => {
      outerStarted.resolve();
      await beginNested.promise;
      const nested = await runWithDiagnosticTraceContext(traces.second, () =>
        beginSessionWorkAdmission({
          ...target,
          assertAllowed: async () => {
            nestedStarted.resolve();
            await releaseNested.promise;
          },
          revalidateAllowed: () => {},
        }),
      );
      nested.release();
      await releaseOuter.promise;
    },
    revalidateAllowed: () => {},
  }).then((lease) => lease.release());
  await outerStarted.promise;
  holders[0]!.release();
  await holders[0]!.promise;
  beginNested.resolve();
  await nestedStarted.promise;
  const waiters = Array.from({ length: 33 }, () => hold("lifecycle", target));
  try {
    await advance(0);
    expect(vi.getTimerCount()).toBe(32);
    await advance(1_000);
    const waiting = await records("session lifecycle queue waiting");
    expect(waiting).toHaveLength(32);
    expect(waiting.every((row) => row.holderObserved === false)).toBe(true);
    expect(waiting.every((row) => row.holderTraceId === undefined)).toBe(true);
    expect(waiting.every((row) => row.operationTraceId === undefined)).toBe(true);
    expect(new Set(waiting.map((row) => row.identityHash)).size).toBe(1);
    expect(waiting[0]?.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(waiting)).not.toContain(target.scope);
    expect(JSON.stringify(waiting)).not.toContain(target.identities[0]);
    expect(
      waiting.some(
        (row) => typeof row.omittedObservations === "number" && row.omittedObservations > 0,
      ),
    ).toBe(true);
  } finally {
    beginNested.resolve();
    releaseNested.resolve();
    releaseOuter.resolve();
    holders.forEach((holder) => holder.release());
    waiters.forEach((waiter) => waiter.release());
    await Promise.allSettled([
      outer,
      ...holders.map((holder) => holder.promise),
      ...waiters.map((waiter) => waiter.promise),
    ]);
  }
  const waiting = await records("session lifecycle queue waiting");
  const completed = await records("slow session lifecycle operation");
  expect(waiting.length + completed.length).toBe(60);
  await advance(60_000);
  const later = hold("mutation", { scope: "after-budget", identities: ["session"] });
  await later.entered;
  await advance(1_000);
  later.release();
  await later.promise;
  const after = await records("slow session lifecycle operation");
  expect(after.at(-1)?.omittedObservations).toBeGreaterThan(0);
});

it("shares live holder observations across separately loaded module graphs", async () => {
  const target = { scope: "fresh-module-store", identities: ["fresh-module-session"] };
  const holder = hold("mutation", target, traces.first);
  await holder.entered;
  // Reset the dependency graph too; query-busting only admission would reuse its diagnostic module.
  vi.resetModules();
  const second = await import("./session-lifecycle-admission.js");
  const freshLogging = await import("../logging/logger.js");
  const freshDiagnostics = await import("../infra/diagnostic-events.js");
  freshLogging.setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
  freshDiagnostics.setDiagnosticsEnabledForProcess(true);
  const waiterRan = vi.fn(async () => {});
  const waiter = runWithDiagnosticTraceContext(traces.waiter, () =>
    second.runExclusiveSessionLifecycleMutation({ ...target, run: waiterRan }),
  );
  try {
    expect(second.runExclusiveSessionLifecycleMutation).not.toBe(
      runExclusiveSessionLifecycleMutation,
    );
    await advance(1_000);
    await freshLogging.flushLogger();
    expect(await records("session lifecycle queue waiting")).toEqual([
      expect.objectContaining({
        operationTraceId: traces.waiter.traceId,
        holderTraceId: traces.first.traceId,
        holderObserved: true,
      }),
    ]);
    expect(waiterRan).not.toHaveBeenCalled();
  } finally {
    holder.release();
    await Promise.allSettled([holder.promise, waiter]);
    await freshLogging.flushLogger();
    freshDiagnostics.setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    freshLogging.setLoggerOverride(null);
    freshLogging.resetLogger();
  }
  expect(waiterRan).toHaveBeenCalledOnce();
});

it("preserves operation errors and queue release when the native logging sink throws", async () => {
  vi.resetModules();
  const logging = await import("../logging/logger.js");
  const diagnostics = await import("../infra/diagnostic-events.js");
  logging.setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
  diagnostics.setDiagnosticsEnabledForProcess(true);
  const logger = logging.getLogger();
  const transport = expectDefined(logger.settings.attachedTransports[0], "native logger transport");
  const previousWrite = expectDefined(
    Object.getOwnPropertyDescriptor(transport, "write"),
    "native logger write descriptor",
  );
  const failedSink = vi.fn(() => {
    throw new Error("diagnostic sink unavailable");
  });
  transport.write = failedSink;
  const lifecycle = await import("./session-lifecycle-admission.js");
  const started = createDeferred();
  const release = createDeferred();
  const operationError = new Error("original operation failure");
  const target = { scope: "failed-sink-store", identities: ["failed-sink-session"] };
  const first = lifecycle.runExclusiveSessionLifecycleMutation({
    ...target,
    run: async () => {
      started.resolve();
      await release.promise;
      throw operationError;
    },
  });
  const firstOutcome = first.catch((error: unknown) => error);
  await started.promise;
  const second = lifecycle.runExclusiveSessionLifecycleMutation({
    ...target,
    run: async () => "next operation",
  });
  try {
    await advance(1_000);
    expect(failedSink).toHaveBeenCalled();
    release.resolve();
    await expect(firstOutcome).resolves.toBe(operationError);
    await expect(second).resolves.toBe("next operation");
    expect(lifecycle.getActiveSessionLifecycleMutationCount()).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    Object.defineProperty(transport, "write", previousWrite);
    await logging.flushLogger();
    diagnostics.setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    logging.setLoggerOverride(null);
    logging.resetLogger();
  }
});

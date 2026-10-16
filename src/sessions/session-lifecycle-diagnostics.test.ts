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
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const restores: (() => Promise<void>)[] = [];
function track<T>(promise: Promise<T>) {
  pending.push(promise);
  return promise;
}

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
      const { traceId, spanId, parentSpanId, traceFlags } = record;
      return [{ ...fields, traceId, spanId, parentSpanId, traceFlags }];
    });
}

async function advance(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

type Target = { scope: string; identities: string[] };
function phase(onEnter?: () => void) {
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(release.resolve);
  return {
    entered: entered.promise,
    release: release.resolve,
    run: async () => {
      onEnter?.();
      entered.resolve();
      await release.promise;
    },
  };
}
function operation(
  kind: "lifecycle" | "mutation",
  target: Target,
  run: () => Promise<void>,
  trace?: DiagnosticTraceContext,
  mutation: "patch" | "archive" | "delete" = "patch",
) {
  return track(
    runWithDiagnosticTraceContext(trace, () =>
      kind === "lifecycle"
        ? beginSessionWorkAdmission({
            ...target,
            assertAllowed: run,
            revalidateAllowed: () => {},
          }).then((lease) => lease.release())
        : runExclusiveSessionLifecycleMutation(mutation, { ...target, run }),
    ),
  );
}
function hold(
  kind: "lifecycle" | "mutation",
  target: Target,
  trace?: DiagnosticTraceContext,
  mutation: "patch" | "archive" | "delete" = "patch",
  onEnter?: () => void,
) {
  const gate = phase(onEnter);
  return { ...gate, promise: operation(kind, target, gate.run, trace, mutation) };
}
function reentry(
  kind: Parameters<typeof operation>[0],
  target: Target,
  trace?: DiagnosticTraceContext,
) {
  const outer = phase();
  const nested = phase();
  const beginNested = createDeferred();
  const nestedDone = createDeferred();
  releases.push(beginNested.resolve);
  const run = async () => {
    const released = outer.run();
    await beginNested.promise;
    await operation(kind, target, nested.run, traces.second, "delete");
    nestedDone.resolve();
    await released;
  };
  const promise = operation(kind, target, run, trace, "archive");
  return { ...outer, nested, beginNested, nestedDone: nestedDone.promise, promise };
}
async function finish(
  holds: { release: () => void; promise: Promise<unknown> }[],
  ...other: Promise<unknown>[]
) {
  holds.forEach((item) => item.release());
  await Promise.allSettled([...holds.map((item) => item.promise), ...other]);
}

function expectRows(rows: Record<string, unknown>[], fields: Record<string, unknown>[]) {
  expect(rows).toEqual(
    expect.arrayContaining(fields.map((field) => expect.objectContaining(field))),
  );
}
async function expectWaiting(fields: Record<string, unknown>) {
  expect(await records("session lifecycle queue waiting")).toMatchObject([fields]);
}
function expectPrivate(rows: Record<string, unknown>[], target: Target) {
  const serialized = JSON.stringify(rows);
  expect(serialized).not.toContain(target.scope);
  expect(serialized).not.toContain(target.identities[0]);
}
async function freshModules() {
  vi.resetModules();
  const logging = await import("../logging/logger.js");
  const diagnostics = await import("../infra/diagnostic-events.js");
  logging.setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
  diagnostics.setDiagnosticsEnabledForProcess(true);
  restores.push(async () => {
    await logging.flushLogger();
    diagnostics.setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    logging.setLoggerOverride(null);
    logging.resetLogger();
  });
  return { logging };
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
  try {
    releases.splice(0).forEach((release) => release());
    while (pending.length) {
      await Promise.allSettled(pending.splice(0));
    }
    for (const restore of restores.splice(0)) {
      await restore();
    }
    await flushLogger();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // A failed leak assertion must still release this fixture's process-wide state.
    vi.useRealTimers();
    vi.restoreAllMocks();
    setDiagnosticsEnabledForProcess(diagnosticsWereEnabled);
    setLoggerOverride(null);
    resetLogger();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("reports the current holder after turnover and preserves the waiter's trace and FIFO order", async () => {
  const target = { scope: "private-store-path", identities: ["private-session-key"] };
  const order: string[] = [];
  const ordered = (name: string) => async () => {
    order.push(name);
  };
  const first = hold("mutation", target, traces.first, "archive", ordered("first"));
  await first.entered;
  const second = hold("mutation", target, traces.second, "delete", ordered("second"));
  const waiter = operation("mutation", target, ordered("waiter"), traces.waiter);
  await advance(500);
  first.release();
  await second.entered;
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
    mutationKind: "patch",
    holderMutationKind: "delete",
    identityCount: 1,
  });
  expect(waiting[0]?.identityHash).toMatch(/^[0-9a-f]{64}$/);
  expect(waiting[0]?.sessionScopeHash).toBe(waiting[0]?.identityHash);
  expect(waiting[0]?.holderSessionScopeHash).toBe(waiting[0]?.sessionScopeHash);
  expectPrivate(waiting, target);
  expect(order).toEqual(["first", "second"]);
  await finish([first, second], waiter);
  expect(order).toEqual(["first", "second", "waiter"]);
  const completed = await records("slow session lifecycle operation");
  expect(completed).toMatchObject(
    ["delete", "patch"].map((mutationKind) => ({
      mutationKind,
      sessionScopeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      identityCount: 1,
    })),
  );
  expectPrivate(completed, target);
});

it("distinguishes mutation and lifecycle holders of the same normalized identity", async () => {
  const target = { scope: "namespace-store", identities: ["namespace-session"] };
  const lifecycle = hold("lifecycle", target, traces.first);
  await lifecycle.entered;
  const mutation = hold("mutation", target, traces.second);
  const waiter = hold("mutation", target, traces.waiter);
  await advance(1_000);
  const waiting = await records("session lifecycle queue waiting");
  expect(waiting).toHaveLength(2);
  expectRows(waiting, [
    {
      queueKind: "lifecycle",
      operationTraceId: traces.second.traceId,
      holderTraceId: traces.first.traceId,
      holderPhase: "run",
    },
    {
      queueKind: "mutation",
      operationTraceId: traces.waiter.traceId,
      holderTraceId: traces.second.traceId,
      holderPhase: "activation",
    },
  ]);
  expect(new Set(waiting.map((record) => record.identityHash)).size).toBe(1);
  await finish([lifecycle, mutation, waiter]);
});

it.each([true, false])(
  "preserves an outer holder through reentry when initially enabled=%s",
  async (initiallyEnabled) => {
    const target = { scope: `reentry-store-${initiallyEnabled}`, identities: ["reentry-session"] };
    setDiagnosticsEnabledForProcess(initiallyEnabled);
    const outer = reentry("mutation", target, traces.first);
    await outer.entered;
    setDiagnosticsEnabledForProcess(true);
    outer.beginNested.resolve();
    await outer.nested.entered;
    const waiter = hold("mutation", target, traces.waiter);
    await advance(500);
    outer.nested.release();
    await outer.nestedDone;
    await advance(500);
    const waiting = await records("session lifecycle queue waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      operationTraceId: traces.waiter.traceId,
      holderObserved: initiallyEnabled,
      holderTraceId: initiallyEnabled ? traces.first.traceId : undefined,
    });
    expect(waiting[0]?.holderTraceId).not.toBe(traces.second.traceId);
    await finish([outer, waiter]);
  },
);

it("measures prepare and finalize separately while successors wait for real finalization", async () => {
  const target = { scope: "phase-store", identities: ["phase-session"] };
  const prepare = phase();
  const finalize = phase();
  const first = track(
    runWithDiagnosticTraceContext(traces.first, () =>
      runExclusiveSessionLifecycleMutation("archive", {
        ...target,
        prepare: prepare.run,
        run: async () => {
          clock += 30;
        },
        finalize: finalize.run,
      }),
    ),
  );
  await prepare.entered;
  await advance(200);
  prepare.release();
  await finalize.entered;
  const waiter = hold("mutation", target, traces.waiter);
  await advance(1_000);
  await expectWaiting({
    operationTraceId: traces.waiter.traceId,
    holderTraceId: traces.first.traceId,
    holderPhase: "finalize",
  });
  finalize.release();
  await finish([waiter], first);
  const completed = await records("slow session lifecycle operation");
  expectRows(completed, [
    {
      operationTraceId: traces.first.traceId,
      phaseDurationsMs: { prepare: 200, run: 30, finalize: 1_000 },
      mutationQueueWaitMs: 0,
      lifecycleQueueWaitMs: 0,
    },
    {
      operationTraceId: traces.waiter.traceId,
      mutationQueueWaitMs: 1_000,
    },
  ]);
});

it("retains a partially acquired holder after caller cancellation until its callback unwinds", async () => {
  const scope = "partial-cancellation-store";
  const blocker = hold("lifecycle", { scope, identities: ["b"] }, traces.first);
  await blocker.entered;
  const controller = new AbortController();
  const cancelledRun = vi.fn(async () => {});
  const cancelled = track(
    runWithDiagnosticTraceContext(traces.second, () =>
      runExclusiveSessionLifecycleMutation("delete", {
        scope,
        identities: ["a", "b"],
        signal: controller.signal,
        run: cancelledRun,
      }),
    ),
  );
  await advance(0);
  const error = new Error("cancel queued mutation");
  controller.abort(error);
  await expect(cancelled).rejects.toBe(error);
  const waiter = hold("mutation", { scope, identities: ["a"] }, traces.waiter);
  await advance(1_000);
  await expectWaiting({
    operationTraceId: traces.waiter.traceId,
    holderTraceId: traces.second.traceId,
    holderPhase: "activation",
    holderSignalAborted: true,
  });
  expect(cancelledRun).not.toHaveBeenCalled();
  await finish([blocker, waiter], cancelled);
  await expect(
    runExclusiveSessionLifecycleMutation("patch", {
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
  setDiagnosticsEnabledForProcess(false);
  await advance(1_000);
  holder.release();
  waiter.release();
  await Promise.all([holder.promise, waiter.promise]);
  expect(await records("session lifecycle queue waiting")).toEqual([]);
  expect(await records("slow session lifecycle operation")).toEqual([]);
  await expect(
    runExclusiveSessionLifecycleMutation("patch", {
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
  const outer = reentry("lifecycle", target);
  await outer.entered;
  holders[0]!.release();
  await holders[0]!.promise;
  outer.beginNested.resolve();
  await outer.nested.entered;
  const waiters = Array.from({ length: 33 }, () => hold("lifecycle", target));
  await advance(0);
  expect(vi.getTimerCount()).toBe(32);
  await advance(1_000);
  const waiting = await records("session lifecycle queue waiting");
  expect(waiting).toHaveLength(32);
  expect(
    waiting.map(({ holderObserved, holderTraceId, operationTraceId }) => [
      holderObserved,
      holderTraceId,
      operationTraceId,
    ]),
  ).toEqual(Array.from({ length: 32 }, () => [false, undefined, undefined]));
  expect(new Set(waiting.map((row) => row.identityHash)).size).toBe(1);
  expect(waiting[0]?.identityHash).toMatch(/^[0-9a-f]{64}$/);
  expectPrivate(waiting, target);
  expect(
    waiting.some(
      (row) => typeof row.omittedObservations === "number" && row.omittedObservations > 0,
    ),
  ).toBe(true);
  outer.nested.release();
  await finish([outer, ...holders, ...waiters]);
  const completed = await records("slow session lifecycle operation");
  expect((await records("session lifecycle queue waiting")).length + completed.length).toBe(60);
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
  const fresh = await freshModules();
  const lifecycle = await import("./session-lifecycle-admission.js");
  const waiterRan = vi.fn(async () => {});
  const waiter = track(
    runWithDiagnosticTraceContext(traces.waiter, () =>
      lifecycle.runExclusiveSessionLifecycleMutation("patch", { ...target, run: waiterRan }),
    ),
  );
  expect(lifecycle.runExclusiveSessionLifecycleMutation).not.toBe(
    runExclusiveSessionLifecycleMutation,
  );
  await advance(1_000);
  await fresh.logging.flushLogger();
  await expectWaiting({
    operationTraceId: traces.waiter.traceId,
    holderTraceId: traces.first.traceId,
    holderObserved: true,
  });
  expect(waiterRan).not.toHaveBeenCalled();
  await finish([holder], waiter);
  expect(waiterRan).toHaveBeenCalledOnce();
});

it("preserves operation errors and queue release when the native logging sink throws", async () => {
  const { logging } = await freshModules();
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
  restores.unshift(async () => {
    Object.defineProperty(transport, "write", previousWrite);
  });
  const blocked = phase();
  const operationError = new Error("original operation failure");
  const target = { scope: "failed-sink-store", identities: ["failed-sink-session"] };
  const first = track(
    lifecycle.runExclusiveSessionLifecycleMutation("delete", {
      ...target,
      run: async () => {
        await blocked.run();
        throw operationError;
      },
    }),
  );
  const firstOutcome = first.catch((error: unknown) => error);
  await blocked.entered;
  const second = track(
    lifecycle.runExclusiveSessionLifecycleMutation("patch", {
      ...target,
      run: async () => "next operation",
    }),
  );
  await advance(1_000);
  expect(failedSink).toHaveBeenCalled();
  blocked.release();
  await expect(firstOutcome).resolves.toBe(operationError);
  await expect(second).resolves.toBe("next operation");
  expect(lifecycle.getActiveSessionLifecycleMutationCount()).toBe(0);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  areDiagnosticsEnabledForProcess as diagnosticsEnabled,
  setDiagnosticsEnabledForProcess as setDiagnostics,
} from "../infra/diagnostic-events.js";
import {
  runWithDiagnosticTraceContext as withTrace,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { logSessionControllerPhase as logPhase } from "./session-controller.diagnostics.js";
import {
  beginSessionEffect as beginEffect,
  captureSessionTarget,
  runSessionMutation as runMutation,
} from "./session-controller.lifecycle.js";
import {
  claimSessionControllerTask as claimTask,
  releaseSessionControllerClaim as releaseClaim,
  reserveSessionControllerSource as reserveSource,
  tryClaimSessionControllerTask as tryClaim,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { findSessionControllerEntry as findEntry } from "./session-controller.state.js";

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
const messages = {
  waiting: "session lifecycle queue waiting",
  slow: "slow session lifecycle operation",
  phase: "session controller phase",
};
type RecordKind = keyof typeof messages;
type Target = { scope: string; identities: string[] };

async function records(kind: RecordKind): Promise<Record<string, unknown>[]> {
  await flushLogger();
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || record.message !== messages[kind]) {
        return [];
      }
      const fields = Object.values(record).find(
        (value): value is Record<string, unknown> => isRecord(value) && "diagnosticEpoch" in value,
      );
      const { traceId, spanId, parentSpanId, traceFlags } = record;
      return [{ ...fields, traceId, spanId, parentSpanId, traceFlags }];
    });
}

async function advance(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function gate(onEnter?: () => void) {
  const [entered, release] = [createDeferred(), createDeferred()];
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

async function expectRecords(kind: RecordKind, rows: Record<string, unknown>[], unordered = false) {
  const actual = await records(kind);
  const expected = rows.map((row) => expect.objectContaining(row));
  expect(actual).toEqual(unordered ? expect.arrayContaining(expected) : expected);
  return actual;
}

async function expectRecord(kind: RecordKind, row: Record<string, unknown>) {
  return (await expectRecords(kind, [row]))[0]!;
}

function expectPrivate(rows: unknown, target: Target) {
  const json = JSON.stringify(rows);
  for (const value of [target.scope, ...target.identities]) {
    expect(json).not.toContain(value);
  }
}

function mutate<T>(
  target: Target,
  trace: DiagnosticTraceContext | undefined,
  options: Pick<
    Parameters<typeof runMutation<T>>[0],
    "run" | "prepare" | "finalize" | "diagnosticLabel"
  >,
) {
  return withTrace(trace, () => runMutation({ ...target, policy: "wait", ...options }));
}

function hold(
  kind: "lifecycle" | "mutation",
  target: Target,
  trace?: DiagnosticTraceContext,
  owner?: symbol,
) {
  const held = gate();
  const promise = withTrace(trace, () =>
    kind === "lifecycle"
      ? beginEffect({
          ...target,
          owner,
          serializeOwner: owner !== undefined,
          assertAllowed: held.run,
          revalidateAllowed: () => {},
        }).then((lease) => lease.release())
      : runMutation({
          ...target,
          run: held.run,
          policy: "wait",
          diagnosticLabel: "sharing",
        }),
  );
  return { ...held, promise };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-diagnostics-"));
  logFile = path.join(directory, "runtime.log");
  fs.writeFileSync(logFile, "");
  diagnosticsWereEnabled = diagnosticsEnabled();
  setDiagnostics(true);
  resetLogger();
  setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
  clock += 120_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(async () => {
  try {
    await flushLogger();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // A failed leak assertion must still release this fixture's process-wide state.
    vi.useRealTimers();
    vi.restoreAllMocks();
    setDiagnostics(diagnosticsWereEnabled);
    setLoggerOverride(null);
    resetLogger();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "reports a long acquired effect only when contended=%s",
  async (contended) => {
    const target = { scope: "acquired-effect-store", identities: ["acquired-effect-session"] };
    const owner = Symbol("effect-producer");
    const effect = await withTrace(traces.first, () =>
      beginEffect({ ...target, owner, serializeOwner: true }),
    );
    const waiter = contended ? hold("lifecycle", target, traces.waiter, owner) : undefined;
    try {
      await advance(2_000);
      await expectRecords(
        "waiting",
        contended
          ? [
              {
                operationTraceId: traces.waiter.traceId,
                holderTraceId: traces.first.traceId,
                holderObserved: true,
                holderPhase: "run",
                queueKind: "lifecycle",
                waitMs: 2_000,
              },
            ]
          : [],
      );
    } finally {
      effect.release();
      waiter?.release();
      await waiter?.promise;
    }
    await expectRecords(
      "slow",
      contended
        ? [
            {
              operationTraceId: traces.first.traceId,
              lifecycleQueueWaitMs: 0,
              phaseDurationsMs: { prepare: 0, run: 2_000, finalize: 0 },
            },
            { operationTraceId: traces.waiter.traceId, lifecycleQueueWaitMs: 2_000 },
          ]
        : [],
    );
  },
);

it("reports the current holder after turnover and preserves the waiter's trace and FIFO order", async () => {
  const target = { scope: "private-store-path", identities: ["private-session-key"] };
  const order: string[] = [];
  const firstGate = gate(() => order.push("first"));
  const secondGate = gate(() => order.push("second"));
  const first = mutate(target, traces.first, { diagnosticLabel: "create", run: firstGate.run });
  await firstGate.entered;
  const second = mutate(target, traces.second, { diagnosticLabel: "delete", run: secondGate.run });
  const waiter = mutate(target, traces.waiter, {
    diagnosticLabel: "sharing",
    run: async () => {
      order.push("waiter");
    },
  });
  try {
    await advance(500);
    firstGate.release();
    await secondGate.entered;
    await advance(500);
    const row = await expectRecord("waiting", {
      operationTraceId: traces.waiter.traceId,
      holderTraceId: traces.second.traceId,
      traceId: traces.waiter.traceId,
      parentSpanId: traces.waiter.parentSpanId,
      traceFlags: traces.waiter.traceFlags,
      queueKind: "mutation",
      holderPhase: "run",
      holderObserved: true,
      waitMs: 1_000,
      mutationKind: "sharing",
      holderMutationKind: "delete",
      identityCount: 1,
    });
    expect(row.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({
      sessionScopeHash: row.identityHash,
      holderSessionScopeHash: row.identityHash,
    });
    expectPrivate([row], target);
    expect(order).toEqual(["first", "second"]);
  } finally {
    firstGate.release();
    secondGate.release();
    await Promise.allSettled([first, second, waiter]);
  }
  expect(order).toEqual(["first", "second", "waiter"]);
  const completed = await expectRecords(
    "slow",
    ["delete", "sharing"].map((mutationKind) => ({
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
  try {
    await advance(1_000);
    const waiting = await expectRecords(
      "waiting",
      [
        {
          queueKind: "lifecycle",
          operationTraceId: traces.second.traceId,
          holderTraceId: traces.first.traceId,
          holderPhase: "prepare",
        },
        {
          queueKind: "mutation",
          operationTraceId: traces.waiter.traceId,
          holderTraceId: traces.second.traceId,
          holderPhase: "run-admission",
        },
      ],
      true,
    );
    expect(waiting).toHaveLength(2);
    expect(new Set(waiting.map((record) => record.identityHash)).size).toBe(1);
  } finally {
    lifecycle.release();
    mutation.release();
    waiter.release();
    await Promise.allSettled([lifecycle.promise, mutation.promise, waiter.promise]);
  }
});

it("leaves the holder unknown while waiting on a turn instead of naming an unrelated effect", async () => {
  const target = captureSessionTarget({
    storeScope: "turn-observation-store",
    sessionKey: "turn-observation-session",
    incarnation: "waiting-turn",
  });
  const turn = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "waiting-turn",
    target,
    resetTriggered: false,
  });
  const unrelated = hold(
    "lifecycle",
    { scope: target.storeScope, identities: [target.sessionKey, "other-incarnation"] },
    traces.first,
  );
  await unrelated.entered;
  const waiter = withTrace(traces.waiter, () =>
    runMutation({
      target,
      requiredSessionId: "waiting-turn",
      policy: "wait",
      run: async () => {},
    }),
  );
  try {
    await advance(1_000);
    await expectRecord("waiting", {
      operationTraceId: traces.waiter.traceId,
      holderObserved: false,
      queueKind: "lifecycle",
    });
  } finally {
    turn.complete();
    unrelated.release();
    await Promise.allSettled([unrelated.promise, waiter]);
  }
});

it.each([true, false])(
  "preserves an outer holder through reentry when initially enabled=%s",
  async (initiallyEnabled) => {
    const target = { scope: `reentry-store-${initiallyEnabled}`, identities: ["reentry-session"] };
    const [outerStarted, beginNested] = [createDeferred(), createDeferred()];
    const nested = gate();
    const [nestedDone, releaseOuter] = [createDeferred(), createDeferred()];
    setDiagnostics(initiallyEnabled);
    const outer = mutate(target, traces.first, {
      diagnosticLabel: "create",
      run: async () => {
        outerStarted.resolve();
        await beginNested.promise;
        await mutate(target, traces.second, {
          diagnosticLabel: "delete",
          run: nested.run,
        });
        nestedDone.resolve();
        await releaseOuter.promise;
      },
    });
    await outerStarted.promise;
    setDiagnostics(true);
    beginNested.resolve();
    await nested.entered;
    const waiter = hold("mutation", target, traces.waiter);
    try {
      await advance(500);
      nested.release();
      await nestedDone.promise;
      await advance(500);
      const row = await expectRecord("waiting", {
        operationTraceId: traces.waiter.traceId,
        holderObserved: initiallyEnabled,
      });
      expect(row.holderTraceId).toBe(initiallyEnabled ? traces.first.traceId : undefined);
      expect(row.holderTraceId).not.toBe(traces.second.traceId);
    } finally {
      beginNested.resolve();
      nested.release();
      releaseOuter.resolve();
      waiter.release();
      await Promise.allSettled([outer, waiter.promise]);
    }
  },
);

it("measures prepare and finalize separately while successors wait for real finalization", async () => {
  const target = { scope: "phase-store", identities: ["phase-session"] };
  const [prepare, finalize] = [gate(), gate()];
  const first = mutate(target, traces.first, {
    diagnosticLabel: "create",
    prepare: prepare.run,
    run: async () => {
      clock += 30;
    },
    finalize: finalize.run,
  });
  await prepare.entered;
  await advance(200);
  prepare.release();
  await finalize.entered;
  const waiter = hold("mutation", target, traces.waiter);
  try {
    await advance(1_000);
    await expectRecord("waiting", {
      operationTraceId: traces.waiter.traceId,
      holderTraceId: traces.first.traceId,
      holderPhase: "finalize",
    });
  } finally {
    prepare.release();
    finalize.release();
    waiter.release();
    await Promise.allSettled([first, waiter.promise]);
  }
  await expectRecords(
    "slow",
    [
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
    ],
    true,
  );
});

it("keeps canceled validator custody visible until the real callback returns", async () => {
  const target = {
    scope: "cancelled-validator-store",
    identities: ["cancelled-validator-session"],
  };
  const controller = new AbortController();
  const validator = gate();
  const error = new Error("cancel validator");
  const effect = withTrace(traces.first, () =>
    beginEffect({
      ...target,
      signal: controller.signal,
      assertAllowed: validator.run,
      revalidateAllowed: () => {},
    }),
  );
  await validator.entered;
  controller.abort(error);
  await expect(effect).rejects.toBe(error);
  const waiter = hold("mutation", target, traces.waiter);
  try {
    await advance(1_000);
    await expectRecord("waiting", {
      operationTraceId: traces.waiter.traceId,
      holderTraceId: traces.first.traceId,
      holderPhase: "prepare",
      holderSignalAborted: true,
      queueKind: "lifecycle",
    });
  } finally {
    validator.release();
    waiter.release();
    await Promise.allSettled([effect, waiter.promise]);
  }
  await expectRecords(
    "slow",
    [
      {
        operationTraceId: traces.first.traceId,
        signalAborted: true,
        elapsedMs: 1_000,
      },
    ],
    true,
  );
});

it("stops pending and terminal emissions when diagnostics are disabled without changing results", async () => {
  const target = { scope: "disabled-store", identities: ["disabled-session"] };
  const holder = hold("mutation", target, traces.first);
  await holder.entered;
  const waiter = hold("mutation", target, traces.waiter);
  try {
    setDiagnostics(false);
    await advance(1_000);
  } finally {
    holder.release();
    waiter.release();
    await Promise.all([holder.promise, waiter.promise]);
  }
  expect(await records("waiting")).toEqual([]);
  expect(await records("slow")).toEqual([]);
  await expect(
    runMutation({
      diagnosticLabel: "sharing",
      policy: "wait",
      ...target,
      run: async () => "disabled-fast-path",
    }),
  ).resolves.toBe("disabled-fast-path");
});

it("bounds holder, timer and warning state without inventing a holder", async () => {
  const holders = Array.from({ length: 128 }, (_, index) =>
    hold("lifecycle", { scope: `bounded-holder-${index}`, identities: ["session"] }),
  );
  await Promise.all(holders.map((holder) => holder.entered));
  const target = { scope: "sensitive-capacity-store", identities: ["sensitive-capacity-session"] };
  const owner = Symbol("bounded-effect-producer");
  const unobserved = hold("lifecycle", target, traces.first, owner);
  await unobserved.entered;
  holders[0]!.release();
  await holders[0]!.promise;
  const waiters = Array.from({ length: 33 }, () => hold("lifecycle", target, undefined, owner));
  try {
    await advance(0);
    expect(vi.getTimerCount()).toBe(32);
    await advance(1_000);
    const waiting = await records("waiting");
    expect(waiting).toHaveLength(32);
    expect(waiting.every((row) => row.holderObserved === false)).toBe(true);
    expect(waiting.every((row) => row.holderTraceId === undefined)).toBe(true);
    expect(new Set(waiting.map((row) => row.identityHash)).size).toBe(1);
    expectPrivate(waiting, target);
    expect(
      waiting.some(
        (row) => typeof row.omittedObservations === "number" && row.omittedObservations > 0,
      ),
    ).toBe(true);
  } finally {
    unobserved.release();
    holders.forEach((holder) => holder.release());
    waiters.forEach((waiter) => waiter.release());
    await Promise.allSettled([
      unobserved.promise,
      ...holders.map((holder) => holder.promise),
      ...waiters.map((waiter) => waiter.promise),
    ]);
  }
  const waiting = await records("waiting");
  const completed = await records("slow");
  expect(waiting.length + completed.length).toBe(60);
  await advance(60_000);
  const later = hold("mutation", { scope: "after-budget", identities: ["session"] });
  await later.entered;
  await advance(1_000);
  later.release();
  await later.promise;
  expect((await records("slow")).at(-1)?.omittedObservations).toBeGreaterThan(0);
});

it("does not let pre-dispatch bypass an older preparing input or retain a failed claim request", async () => {
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
  const sessionKey = "agent:phase-claim:test";
  let firstClaim: ReturnType<typeof tryClaim>;
  let secondClaim: ReturnType<typeof tryClaim>;
  try {
    const first = reserveSource(sessionKey, { policy: { mode: "followup" } });
    const second = reserveSource(sessionKey, { policy: { mode: "followup" } });
    expect(tryClaim(second)).toBeUndefined();
    firstClaim = tryClaim(first);
    expect(firstClaim?.inputs).toEqual([first]);
    expect(tryClaim(second)).toBeUndefined();
    releaseClaim(firstClaim!);
    await firstClaim!.settlement.promise;
    secondClaim = await claimTask(second, () => {});
    expect(secondClaim.inputs).toEqual([second]);
    expect(
      (await records("phase"))
        .filter((record) => record.phase === "source-claim")
        .map((record) => record.status),
    ).toEqual(["selected", "waiting", "selected"]);
  } finally {
    const claims = [firstClaim, secondClaim].filter((claim) => claim !== undefined);
    for (const claim of claims) {
      releaseClaim(claim);
    }
    await Promise.all(claims.map((claim) => claim.settlement.promise));
  }
  expect(findEntry(sessionKey)).toBeUndefined();
});

it("gates and hashes phase events without consuming the slow-warning budget", async () => {
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
  const fields = {
    phase: "source-claim" as const,
    status: "waiting" as const,
    sessionKey: "sensitive-phase-session-key",
    sessionId: "sensitive-phase-session-id",
    sourceId: "sensitive-phase-source-id",
    prioritySourceId: "sensitive-phase-priority-id",
  };
  setDiagnostics(false);
  logPhase(fields);
  expect(await records("phase")).toEqual([]);
  setDiagnostics(true);
  for (let index = 0; index < 65; index++) {
    logPhase(fields);
  }
  const phases = await records("phase");
  expect(phases).toHaveLength(60);
  expect(phases[0]).toMatchObject({
    sessionScopeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    sessionIdHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    sourceIdHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    prioritySourceIdHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(JSON.stringify(phases)).not.toContain("sensitive-phase-");
  const holder = hold("mutation", {
    scope: "phase-budget-store",
    identities: ["phase-budget-session"],
  });
  await holder.entered;
  try {
    await advance(1_000);
  } finally {
    holder.release();
    await holder.promise;
  }
  expect(await records("slow")).toHaveLength(1);
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
  const lifecycle = await import("./session-controller.lifecycle.js");
  const [started, release] = [createDeferred(), createDeferred()];
  const operationError = new Error("original operation failure");
  const target = { scope: "failed-sink-store", identities: ["failed-sink-session"] };
  const first = lifecycle.runSessionMutation({
    diagnosticLabel: "delete",
    policy: "wait",
    ...target,
    run: async () => {
      started.resolve();
      await release.promise;
      throw operationError;
    },
  });
  const firstOutcome = first.catch((error: unknown) => error);
  await started.promise;
  const second = lifecycle.runSessionMutation({
    diagnosticLabel: "sharing",
    policy: "wait",
    ...target,
    run: async () => "next operation",
  });
  try {
    await advance(1_000);
    expect(failedSink).toHaveBeenCalled();
    release.resolve();
    await expect(firstOutcome).resolves.toBe(operationError);
    await expect(second).resolves.toBe("next operation");
    expect(lifecycle.getSessionMutationCount()).toBe(0);
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

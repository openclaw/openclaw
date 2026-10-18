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
import { logSessionControllerPhase } from "./session-controller.diagnostics.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  runSessionMutation,
} from "./session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { findSessionControllerEntry } from "./session-controller.state.js";

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
        (value): value is Record<string, unknown> => isRecord(value) && "diagnosticEpoch" in value,
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
  owner?: symbol,
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
      ? beginSessionEffect({
          ...target,
          owner,
          serializeOwner: owner !== undefined,
          assertAllowed: params.run,
          revalidateAllowed: () => {},
        }).then((lease) => lease.release())
      : runSessionMutation({ ...params, policy: "wait", diagnosticLabel: "sharing" }),
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
  try {
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
  const firstStarted = createDeferred();
  const secondStarted = createDeferred();
  const releaseFirst = createDeferred();
  const releaseSecond = createDeferred();
  const order: string[] = [];
  const first = runWithDiagnosticTraceContext(traces.first, () =>
    runSessionMutation({
      diagnosticLabel: "create",
      policy: "wait",
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
    runSessionMutation({
      diagnosticLabel: "delete",
      policy: "wait",
      ...target,
      run: async () => {
        order.push("second");
        secondStarted.resolve();
        await releaseSecond.promise;
      },
    }),
  );
  const waiter = runWithDiagnosticTraceContext(traces.waiter, () =>
    runSessionMutation({
      diagnosticLabel: "sharing",
      policy: "wait",
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
      mutationKind: "sharing",
      holderMutationKind: "delete",
      identityCount: 1,
    });
    expect(waiting[0]?.identityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(waiting[0]?.sessionScopeHash).toBe(waiting[0]?.identityHash);
    expect(waiting[0]?.holderSessionScopeHash).toBe(waiting[0]?.sessionScopeHash);
    expect(JSON.stringify(waiting)).not.toContain(target.scope);
    expect(JSON.stringify(waiting)).not.toContain(target.identities[0]);
    expect(order).toEqual(["first", "second"]);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.allSettled([first, second, waiter]);
  }
  expect(order).toEqual(["first", "second", "waiter"]);
  const completed = await records("slow session lifecycle operation");
  expect(completed).toEqual([
    expect.objectContaining({
      mutationKind: "delete",
      sessionScopeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      identityCount: 1,
    }),
    expect.objectContaining({
      mutationKind: "sharing",
      sessionScopeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      identityCount: 1,
    }),
  ]);
  expect(JSON.stringify(completed)).not.toContain(target.scope);
  expect(JSON.stringify(completed)).not.toContain(target.identities[0]);
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
          holderPhase: "prepare",
        }),
        expect.objectContaining({
          queueKind: "mutation",
          operationTraceId: traces.waiter.traceId,
          holderTraceId: traces.second.traceId,
          holderPhase: "run-admission",
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
  const waiter = runWithDiagnosticTraceContext(traces.waiter, () =>
    runSessionMutation({
      target,
      requiredSessionId: "waiting-turn",
      policy: "wait",
      run: async () => {},
    }),
  );
  try {
    await advance(1_000);
    expect(await records("session lifecycle queue waiting")).toEqual([
      expect.objectContaining({
        operationTraceId: traces.waiter.traceId,
        holderObserved: false,
        queueKind: "lifecycle",
      }),
    ]);
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
    const outerStarted = createDeferred();
    const beginNested = createDeferred();
    const nestedStarted = createDeferred();
    const releaseNested = createDeferred();
    const nestedDone = createDeferred();
    const releaseOuter = createDeferred();
    setDiagnosticsEnabledForProcess(initiallyEnabled);
    const outer = runWithDiagnosticTraceContext(traces.first, () =>
      runSessionMutation({
        diagnosticLabel: "create",
        policy: "wait",
        ...target,
        run: async () => {
          outerStarted.resolve();
          await beginNested.promise;
          await runWithDiagnosticTraceContext(traces.second, () =>
            runSessionMutation({
              diagnosticLabel: "delete",
              policy: "wait",
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
    runSessionMutation({
      diagnosticLabel: "create",
      policy: "wait",
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

it("keeps canceled validator custody visible until the real callback returns", async () => {
  const target = {
    scope: "cancelled-validator-store",
    identities: ["cancelled-validator-session"],
  };
  const controller = new AbortController();
  const entered = createDeferred();
  const finish = createDeferred();
  const error = new Error("cancel validator");
  const effect = runWithDiagnosticTraceContext(traces.first, () =>
    beginSessionEffect({
      ...target,
      signal: controller.signal,
      assertAllowed: async () => {
        entered.resolve();
        await finish.promise;
      },
      revalidateAllowed: () => {},
    }),
  );
  await entered.promise;
  controller.abort(error);
  await expect(effect).rejects.toBe(error);
  const waiter = hold("mutation", target, traces.waiter);
  try {
    await advance(1_000);
    expect(await records("session lifecycle queue waiting")).toEqual([
      expect.objectContaining({
        operationTraceId: traces.waiter.traceId,
        holderTraceId: traces.first.traceId,
        holderPhase: "prepare",
        holderSignalAborted: true,
        queueKind: "lifecycle",
      }),
    ]);
  } finally {
    finish.resolve();
    waiter.release();
    await Promise.allSettled([effect, waiter.promise]);
  }
  expect(await records("slow session lifecycle operation")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationTraceId: traces.first.traceId,
        signalAborted: true,
        elapsedMs: 1_000,
      }),
    ]),
  );
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
    runSessionMutation({
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
    const waiting = await records("session lifecycle queue waiting");
    expect(waiting).toHaveLength(32);
    expect(waiting.every((row) => row.holderObserved === false)).toBe(true);
    expect(waiting.every((row) => row.holderTraceId === undefined)).toBe(true);
    expect(new Set(waiting.map((row) => row.identityHash)).size).toBe(1);
    expect(JSON.stringify(waiting)).not.toContain(target.scope);
    expect(JSON.stringify(waiting)).not.toContain(target.identities[0]);
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
  const waiting = await records("session lifecycle queue waiting");
  const completed = await records("slow session lifecycle operation");
  expect(waiting.length + completed.length).toBe(60);
  await advance(60_000);
  const later = hold("mutation", { scope: "after-budget", identities: ["session"] });
  await later.entered;
  await advance(1_000);
  later.release();
  await later.promise;
  expect(
    (await records("slow session lifecycle operation")).at(-1)?.omittedObservations,
  ).toBeGreaterThan(0);
});

it("does not let pre-dispatch bypass an older preparing input or retain a failed claim request", async () => {
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
  const sessionKey = "agent:phase-claim:test";
  let firstClaim: ReturnType<typeof tryClaimSessionControllerTask>;
  let secondClaim: ReturnType<typeof tryClaimSessionControllerTask>;
  try {
    const first = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    const second = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    expect(tryClaimSessionControllerTask(second)).toBeUndefined();
    firstClaim = tryClaimSessionControllerTask(first);
    expect(firstClaim?.inputs).toEqual([first]);
    expect(tryClaimSessionControllerTask(second)).toBeUndefined();
    releaseSessionControllerClaim(firstClaim!);
    await firstClaim!.settlement.promise;
    secondClaim = await claimSessionControllerTask(second, () => {});
    expect(secondClaim.inputs).toEqual([second]);
    expect(
      (await records("session controller phase"))
        .filter((record) => record.phase === "source-claim")
        .map((record) => record.status),
    ).toEqual(["selected", "waiting", "selected"]);
  } finally {
    const claims = [firstClaim, secondClaim].filter((claim) => claim !== undefined);
    for (const claim of claims) {
      releaseSessionControllerClaim(claim);
    }
    await Promise.all(claims.map((claim) => claim.settlement.promise));
  }
  expect(findSessionControllerEntry(sessionKey)).toBeUndefined();
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
  setDiagnosticsEnabledForProcess(false);
  logSessionControllerPhase(fields);
  expect(await records("session controller phase")).toEqual([]);
  setDiagnosticsEnabledForProcess(true);
  for (let index = 0; index < 65; index++) {
    logSessionControllerPhase(fields);
  }
  const phases = await records("session controller phase");
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
  expect(await records("slow session lifecycle operation")).toHaveLength(1);
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
  const started = createDeferred();
  const release = createDeferred();
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

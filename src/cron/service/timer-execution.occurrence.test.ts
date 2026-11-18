import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import {
  unadmittedScheduledOccurrence,
  type ScheduledOccurrence,
} from "../scheduled-occurrence.js";
import type { CronStoredJob } from "../types.js";
import type { CronServiceDeps } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

/**
 * Every executor the cron service can call, classified by whether it starts
 * work for an admitted occurrence. Adding an executor to `CronServiceDeps`
 * without classifying it here fails typecheck.
 */
type CronExecutorDep = Extract<
  keyof CronServiceDeps,
  `run${string}` | `evaluate${string}` | `enqueue${string}`
>;
const EXECUTOR_ADMISSION = {
  evaluateCronCheck: "occurrence",
  runIsolatedAgentJob: "occurrence",
  runSessionEvent: "occurrence",
  // Consumes the occurrence; a command is not an agent run and mints no context.
  runCommandJob: "occurrence",
  // Producer events enter ordinary session admission.
  enqueueSystemEvent: "not-admitted",
  enqueueSessionEvent: "not-admitted",
  // Scheduler binding, not an executor.
  runSchedulerOwned: "not-admitted",
  // An ordinary turn in the owning conversation after a failed occurrence settles.
  runCronFailureRepair: "not-admitted",
} as const satisfies Record<CronExecutorDep, "occurrence" | "not-admitted">;

type OccurrenceExecutor = {
  [K in keyof typeof EXECUTOR_ADMISSION]: (typeof EXECUTOR_ADMISSION)[K] extends "occurrence"
    ? K
    : never;
}[keyof typeof EXECUTOR_ADMISSION];
// An executor classified as admitted must require the occurrence in its params.
type RequiresOccurrence<K extends OccurrenceExecutor> = Parameters<
  NonNullable<CronServiceDeps[K]>
>[0] extends { occurrence: ScheduledOccurrence }
  ? true
  : false;
const executorsRequireOccurrence: { [K in OccurrenceExecutor]: RequiresOccurrence<K> } = {
  evaluateCronCheck: true,
  runIsolatedAgentJob: true,
  runSessionEvent: true,
  runCommandJob: true,
};

type PayloadKind = CronStoredJob["payload"]["kind"];

function payloadFor(kind: PayloadKind): CronStoredJob["payload"] {
  switch (kind) {
    case "agentTurn":
      return { kind, message: "work" };
    case "systemEvent":
      return { kind, text: "check in" };
    case "command":
      return { kind, argv: ["true"] };
    case "none":
      return { kind };
  }
  throw new Error(`unclassified payload kind ${String(kind)}`);
}

const PAYLOAD_KINDS: readonly PayloadKind[] = ["agentTurn", "systemEvent", "command", "none"];
const SESSION_TARGETS: readonly CronStoredJob["sessionTarget"][] = [
  "isolated",
  "current",
  "session:agent:main:dashboard:parent",
  "main",
];

function harness() {
  const admitted: ScheduledOccurrence[] = [];
  const release = vi.fn();
  const seen: Array<{ executor: string; occurrence: unknown }> = [];
  const record =
    (executor: string, result: Record<string, unknown> = { status: "ok" }) =>
    async (params: { occurrence?: unknown }) => {
      seen.push({ executor, occurrence: params.occurrence });
      return result as never;
    };
  const state = createCronRegressionState({
    storePath: "/tmp/cron-occurrence-matrix.json",
    admitScheduledOccurrence: vi.fn(async () => {
      const occurrence = { ...unadmittedScheduledOccurrence("matrix"), release };
      admitted.push(occurrence);
      return occurrence;
    }),
    evaluateCronCheck: record("evaluateCronCheck", { kind: "evaluated", action: "wake" }),
    runIsolatedAgentJob: record("runIsolatedAgentJob"),
    runSessionEvent: record("runSessionEvent"),
    runCommandJob: record("runCommandJob"),
  });
  return { state, admitted, release, seen };
}

const MATRIX = PAYLOAD_KINDS.flatMap((kind) =>
  SESSION_TARGETS.flatMap((sessionTarget) =>
    (kind === "agentTurn" ? [false, true] : [kind === "none"]).map((withTrigger) => ({
      kind,
      sessionTarget,
      withTrigger,
    })),
  ),
);

describe("scheduled occurrence admission", () => {
  it.each(["quiet", "post", "wake"] as const)("dispatches only the %s effect", async (action) => {
    const { state, seen, release } = harness();
    state.deps.evaluateCronCheck = vi.fn(async () => ({
      kind: "evaluated",
      action,
      message: "Workspace degraded",
      state: { status: "degraded" },
    }));
    state.deps.deliverCheckPost = vi.fn(async () => ({ delivered: true }));
    const payload =
      action === "wake"
        ? ({ kind: "agentTurn", message: "Summarize the status" } as const)
        : ({ kind: "none" } as const);
    const run = vi.mocked(state.deps.runIsolatedAgentJob!);
    state.deps.runIsolatedAgentJob = vi.fn(run);
    const result = await executeJobCore(state, {
      ...makeCronJob({ payload, sessionTarget: "isolated" }),
      check: { script: "return {}" },
    });
    expect(result).toMatchObject({
      status: "ok",
      triggerEval: { fired: action !== "quiet", stateChanged: true, state: { status: "degraded" } },
    });
    if (action === "post") {
      expect(state.deps.deliverCheckPost).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Workspace degraded" }),
      );
      expect(result.delivered).toBe(true);
    } else expect(state.deps.deliverCheckPost).not.toHaveBeenCalled();
    if (action === "wake") {
      expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({
            payload: { kind: "agentTurn", message: "Summarize the status\n\nWorkspace degraded" },
          }),
        }),
      );
    } else expect(seen).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
  it("classifies every executor that can start occurrence work", () => {
    expect(Object.values(executorsRequireOccurrence).every(Boolean)).toBe(true);
    expect(Object.keys(EXECUTOR_ADMISSION).toSorted()).toMatchInlineSnapshot(`
      [
        "enqueueSessionEvent",
        "enqueueSystemEvent",
        "evaluateCronCheck",
        "runCommandJob",
        "runCronFailureRepair",
        "runIsolatedAgentJob",
        "runSchedulerOwned",
        "runSessionEvent",
      ]
    `);
  });

  it.each(MATRIX)(
    "$kind on $sessionTarget (trigger: $withTrigger) runs every executor with one admitted occurrence",
    async ({ kind, sessionTarget, withTrigger }) => {
      const { state, admitted, release, seen } = harness();
      const job: CronStoredJob = {
        ...makeCronJob({ payload: payloadFor(kind), sessionTarget }),
        ...(withTrigger ? { check: { script: "return { wake: '' }" } } : {}),
      };

      await executeJobCore(state, job);

      expect(admitted).toHaveLength(1);
      for (const call of seen) {
        expect(call, call.executor).toEqual({ executor: call.executor, occurrence: admitted[0] });
      }
      // The occurrence outlives every executor it admitted and is released once.
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("reaches every admitted executor across the matrix", async () => {
    const reached = new Set<string>();
    for (const { kind, sessionTarget, withTrigger } of MATRIX) {
      const { state, seen } = harness();
      await executeJobCore(state, {
        ...makeCronJob({ payload: payloadFor(kind), sessionTarget }),
        ...(withTrigger ? { check: { script: "return { wake: '' }" } } : {}),
      });
      for (const call of seen) {
        reached.add(call.executor);
      }
    }
    expect([...reached].toSorted()).toEqual(Object.keys(executorsRequireOccurrence).toSorted());
  });

  it("admits before trigger evaluation, so a trigger that does not fire still consumes it", async () => {
    const { state, admitted, release } = harness();
    state.deps.evaluateCronCheck = vi.fn(async () => ({
      kind: "evaluated" as const,
      action: "quiet",
    }));
    await executeJobCore(state, {
      ...makeCronJob({ payload: payloadFor("agentTurn") }),
      check: { script: "return { }" },
    });
    expect(admitted).toHaveLength(1);
    expect(state.deps.evaluateCronCheck).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: admitted[0] }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(MATRIX)(
    "a paused $kind occurrence on $sessionTarget (trigger: $withTrigger) runs nothing",
    async ({ kind, sessionTarget, withTrigger }) => {
      const { state, seen } = harness();
      const pause = {
        reason: "archived" as const,
        parentSessionKey: "agent:main:dashboard:parent",
      };
      state.deps.admitScheduledOccurrence = async () => ({
        ...unadmittedScheduledOccurrence("paused"),
        pause,
      });
      const result = await executeJobCore(state, {
        ...makeCronJob({ payload: payloadFor(kind), sessionTarget }),
        ...(withTrigger ? { check: { script: "return { wake: '' }" } } : {}),
      });
      if (kind === "command") {
        // Command jobs do not pause on a missing parent; they still run with the occurrence.
        expect(result).not.toHaveProperty("parentUnavailable");
        if (sessionTarget !== "main") {
          expect(seen.map((call) => call.executor)).toContain("runCommandJob");
        }
        return;
      }
      expect(seen).toEqual([]);
      expect(result).toMatchObject({
        status: "skipped",
        parentUnavailable: pause,
        executionStarted: false,
      });
    },
  );

  it("gives every run a fail context when no admitter is configured", async () => {
    const { state, seen } = harness();
    delete state.deps.admitScheduledOccurrence;
    await executeJobCore(state, makeCronJob({ payload: payloadFor("agentTurn") }));
    const occurrence = seen[0]?.occurrence as ScheduledOccurrence;
    expect(
      occurrence.mint({
        cfg: {},
        agentId: "main",
        runId: "run",
        runSessionKey: "agent:main:cron:job",
      }).result,
    ).toEqual({ status: "fail", error: "occurrence admission is not configured" });
  });
});

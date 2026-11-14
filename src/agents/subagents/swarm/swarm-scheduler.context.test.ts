import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as trace from "../../../infra/diagnostic-trace-context.js";
import * as work from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as caller from "../../tools/gateway-caller-context.js";
import * as swarm from "./swarm-scheduler.js";

const readContext = () => ({
  caller: caller.getGatewayToolCallerIdentity(),
  trace: trace.getActiveDiagnosticTraceContext(),
});
function withContext<T>(agentId: string, run: () => T, traceDigit = "1", span = "2") {
  const identity = { agentId, sessionKey: `agent:${agentId}:main` };
  const context = { traceId: traceDigit.repeat(32), spanId: span.repeat(16) };
  return caller.withGatewayToolCallerIdentity(identity, () =>
    trace.runWithDiagnosticTraceContext(context, run),
  );
}

it.each(["success", "failure", "cancelled", "shutdown"] as const)(
  "retains activation context and joins callback work after %s",
  async (mode) => {
    const removed = mode === "cancelled" || mode === "shutdown";
    const activation = new work.AsyncWorkScope();
    const lifecycleOwner = {};
    const observed: ReturnType<typeof readContext>[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const tails: Promise<void>[] = [];
    const tailFailures: unknown[] = [];
    const entered = createDeferredCore();
    const failureEntered = createDeferredCore();
    const launchTail = createDeferredCore();
    const failureTail = createDeferredCore();
    const failure = new Error("queued launch failed");
    const failures: unknown[] = [];
    const reasons: string[] = [];
    const settled = vi.fn();
    let pending: Promise<void> | undefined;
    const close = () => swarm.closeSwarmScheduler(lifecycleOwner);
    const record = async (tail: Promise<void>, tracked: boolean) => {
      signals.push(work.getAsyncWorkSignal());
      const observe = () => observed.push(readContext());
      if (tracked) {
        await work.trackAsyncWork(observe);
      } else {
        observe();
      }
      const pendingTail = work.trackAsyncWork(async () => {
        await tail;
        observe();
      });
      tails.push(pendingTail);
      void pendingTail.catch((error: unknown) => tailFailures.push(error));
    };
    const start = vi.fn(async () => {
      entered.resolve();
      await record(launchTail.promise, true);
      if (mode === "failure") {
        throw failure;
      }
    });
    const reservation = { groupId: "context", runId: "queued" };
    swarm.reserveSwarmRun({ ...reservation, maxConcurrent: 1, activeRunIds: ["holder"] });
    const onRemoved = async (reason: "cancelled" | "shutdown") => {
      reasons.push(reason);
      await record(launchTail.promise, false);
      entered.resolve();
    };
    try {
      const expected = await activation.run(() =>
        withContext("activation-agent", () => {
          swarm.activateSwarmRun({
            ...reservation,
            lifecycleOwner,
            start,
            onStartFailure: async (error) => {
              failures.push(error);
              failureEntered.resolve();
              await record(failureTail.promise, true);
              return true;
            },
            onRemoved: removed ? onRemoved : undefined,
          });
          return readContext();
        }),
      );
      await activation.drain();
      expect(observed).toEqual([]);
      if (removed) {
        await withContext("removal-agent", () => {
          if (mode === "shutdown") {
            pending = close();
          } else {
            const hold = swarm.holdQueuedSwarmRun("queued");
            expect(hold?.withdraw()).toBe(true);
            pending = hold?.release();
          }
        });
        expect(pending).toBeDefined();
      } else {
        await withContext(
          "release-agent",
          () => expect(swarm.releaseSwarmRun("holder")).toBe(true),
          "3",
          "4",
        );
      }
      await entered.promise;
      await nextTurn();
      expect(signals[0]).toBeDefined();
      expect(signals[0]).not.toBe(activation.signal);
      expect(observed).toEqual([expected]);
      expect(failures).toEqual([]);
      if (mode === "failure") {
        launchTail.resolve();
        await failureEntered.promise;
        await nextTurn();
        expect(failures).toEqual([failure]);
        expect(signals[1]).toBeDefined();
        expect(signals[1]).not.toBe(activation.signal);
        expect(observed).toEqual([expected, expected, expected]);
        expect(swarm.isSwarmRunActive("queued")).toBe(true);
      }
      pending = (pending ?? close()).finally(settled);
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      launchTail.resolve();
      failureTail.resolve();
      await pending;
      expect(expected.caller).toBeDefined();
      expect(expected.trace).toBeDefined();
      expect(observed).toEqual(Array(mode === "failure" ? 4 : 2).fill(expected));
      expect(failures).toEqual(mode === "failure" ? [failure] : []);
      expect(tailFailures).toEqual([]);
      if (removed) {
        expect(start).not.toHaveBeenCalled();
        expect(reasons).toEqual([mode]);
        expect(swarm.releaseSwarmRun("holder")).toBe(true);
      }
    } finally {
      launchTail.resolve();
      failureTail.resolve();
      await pending?.catch(() => {});
      await Promise.allSettled(tails);
      await close();
      swarm.releaseSwarmRun("holder");
    }
  },
);

import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  holdQueuedSwarmRun,
  isSwarmRunActive,
  releaseSwarmRun,
  reserveSwarmRun,
} from "./swarm-scheduler.js";
import { testing } from "./swarm-scheduler.test-support.js";

afterEach(() => testing.reset());

it.each(["success", "failure"] as const)(
  "runs delayed %s callbacks and joins their work after the activation request retires",
  async (outcome) => {
    const readContext = () => ({
      caller: getGatewayToolCallerIdentity(),
      trace: getActiveDiagnosticTraceContext(),
    });
    const activation = new AsyncWorkScope();
    const lifecycleOwner = {};
    const entered = createDeferredCore();
    const launchTail = createDeferredCore();
    const failureEntered = createDeferredCore();
    const failureTail = createDeferredCore();
    const observed: ReturnType<typeof readContext>[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const failure = new Error("queued launch failed");
    const failures: unknown[] = [];
    const tails: Promise<unknown>[] = [];
    const tailFailures: unknown[] = [];
    let expected: ReturnType<typeof readContext> | undefined;
    let closing: Promise<void> | undefined;
    let closed = false;
    const trackTail = (tail: Promise<void>) => {
      const pending = trackAsyncWork(async () => {
        await tail;
        observed.push(readContext());
      });
      tails.push(pending);
      void pending.catch((error: unknown) => tailFailures.push(error));
    };
    reserveSwarmRun({
      groupId: "context-group",
      runId: "queued",
      maxConcurrent: 1,
      activeRunIds: ["holder"],
    });
    try {
      await activation.run(() =>
        withGatewayToolCallerIdentity(
          { agentId: "activation-agent", sessionKey: "agent:activation-agent:main" },
          () =>
            runWithDiagnosticTraceContext(
              { traceId: "1".repeat(32), spanId: "2".repeat(16) },
              () => {
                expected = readContext();
                activateSwarmRun({
                  groupId: "context-group",
                  runId: "queued",
                  lifecycleOwner,
                  start: async () => {
                    entered.resolve();
                    signals.push(getAsyncWorkSignal());
                    await trackAsyncWork(() => observed.push(readContext()));
                    trackTail(launchTail.promise);
                    if (outcome === "failure") {
                      throw failure;
                    }
                  },
                  onStartFailure: async (error) => {
                    failures.push(error);
                    failureEntered.resolve();
                    signals.push(getAsyncWorkSignal());
                    await trackAsyncWork(() => observed.push(readContext()));
                    trackTail(failureTail.promise);
                    return true;
                  },
                });
              },
            ),
        ),
      );
      await activation.drain();
      expect(observed).toEqual([]);
      await withGatewayToolCallerIdentity(
        { agentId: "release-agent", sessionKey: "agent:release-agent:main" },
        () =>
          runWithDiagnosticTraceContext({ traceId: "3".repeat(32), spanId: "4".repeat(16) }, () => {
            expect(releaseSwarmRun("holder")).toBe(true);
          }),
      );
      await entered.promise;
      await nextTurn();
      expect(signals[0]).toBeDefined();
      expect(signals[0]).not.toBe(activation.signal);
      expect(observed).toEqual([expected]);
      expect(failures).toEqual([]);
      if (outcome === "failure") {
        launchTail.resolve();
        await failureEntered.promise;
        await nextTurn();
        expect(failures).toEqual([failure]);
        expect(signals[1]).toBeDefined();
        expect(signals[1]).not.toBe(activation.signal);
        expect(observed).toEqual([expected, expected, expected]);
        expect(isSwarmRunActive("queued")).toBe(true);
      }
      closing = closeSwarmScheduler(lifecycleOwner).then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      launchTail.resolve();
      failureTail.resolve();
      await closing;
      expect(expected?.caller).toBeDefined();
      expect(expected?.trace).toBeDefined();
      expect(observed).toEqual(Array(outcome === "failure" ? 4 : 2).fill(expected));
      expect(failures).toEqual(outcome === "failure" ? [failure] : []);
      expect(tailFailures).toEqual([]);
    } finally {
      launchTail.resolve();
      failureTail.resolve();
      await closing?.catch(() => {});
      await Promise.allSettled(tails);
      await closeSwarmScheduler(lifecycleOwner);
    }
  },
);

it.each(["cancelled", "shutdown"] as const)(
  "keeps activation identity and joins fresh cleanup work after %s",
  async (reason) => {
    const readContext = () => ({
      caller: getGatewayToolCallerIdentity(),
      trace: getActiveDiagnosticTraceContext(),
    });
    const activation = new AsyncWorkScope();
    const lifecycleOwner = {};
    const entered = createDeferredCore();
    const tail = createDeferredCore();
    const observed: ReturnType<typeof readContext>[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const reasons: string[] = [];
    const tails: Promise<void>[] = [];
    const tailFailures: unknown[] = [];
    let expected: ReturnType<typeof readContext> | undefined;
    let removal: Promise<void> | undefined;
    let removalSettled = false;
    reserveSwarmRun({
      groupId: "removal-context",
      runId: "queued-removal",
      maxConcurrent: 1,
      activeRunIds: ["holder"],
    });
    try {
      await activation.run(() =>
        withGatewayToolCallerIdentity(
          { agentId: "activation-agent", sessionKey: "agent:activation-agent:main" },
          () =>
            runWithDiagnosticTraceContext(
              { traceId: "1".repeat(32), spanId: "2".repeat(16) },
              () => {
                expected = readContext();
                activateSwarmRun({
                  groupId: "removal-context",
                  runId: "queued-removal",
                  lifecycleOwner,
                  start: async () => {},
                  onStartFailure: async () => true,
                  onRemoved: async (actualReason) => {
                    reasons.push(actualReason);
                    observed.push(readContext());
                    signals.push(getAsyncWorkSignal());
                    const pending = trackAsyncWork(async () => {
                      await tail.promise;
                      observed.push(readContext());
                    });
                    tails.push(pending);
                    void pending.catch((error: unknown) => {
                      tailFailures.push(error);
                    });
                    entered.resolve();
                  },
                });
              },
            ),
        ),
      );
      await activation.drain();
      await withGatewayToolCallerIdentity(
        { agentId: "removal-agent", sessionKey: "agent:removal-agent:main" },
        () => {
          if (reason === "shutdown") {
            removal = closeSwarmScheduler(lifecycleOwner);
          } else {
            const hold = holdQueuedSwarmRun("queued-removal");
            expect(hold?.withdraw()).toBe(true);
            removal = hold?.release();
          }
        },
      );
      expect(removal).toBeDefined();
      void removal?.then(
        () => {
          removalSettled = true;
        },
        () => {
          removalSettled = true;
        },
      );
      await entered.promise;
      await nextTurn();
      expect(removalSettled).toBe(false);
      expect(signals[0]).toBeDefined();
      expect(signals[0]).not.toBe(activation.signal);
      tail.resolve();
      await removal;
      expect(reasons).toEqual([reason]);
      expect(tailFailures).toEqual([]);
      expect(observed).toEqual([expected, expected]);
    } finally {
      tail.resolve();
      await removal?.catch(() => {});
      await Promise.allSettled(tails);
      await closeSwarmScheduler(lifecycleOwner);
    }
  },
);

import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
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

const readContext = () => ({
  caller: getGatewayToolCallerIdentity(),
  trace: getActiveDiagnosticTraceContext(),
});
function withContext<T>(agentId: string, run: () => T, trace = "1", span = "2") {
  return withGatewayToolCallerIdentity({ agentId, sessionKey: `agent:${agentId}:main` }, () =>
    runWithDiagnosticTraceContext({ traceId: trace.repeat(32), spanId: span.repeat(16) }, run),
  );
}

function createContextRun() {
  const activation = new AsyncWorkScope();
  const lifecycleOwner = {};
  const observed: ReturnType<typeof readContext>[] = [];
  const tails: Promise<void>[] = [];
  const tailFailures: unknown[] = [];
  const trackTail = (tail: Promise<void>) => {
    const pending = trackAsyncWork(async () => {
      await tail;
      observed.push(readContext());
    });
    tails.push(pending);
    void pending.catch((error: unknown) => tailFailures.push(error));
  };
  const activate = async (
    launch: Pick<Parameters<typeof activateSwarmRun>[0], "start" | "onStartFailure" | "onRemoved">,
  ) => {
    reserveSwarmRun({
      groupId: "context",
      runId: "queued",
      maxConcurrent: 1,
      activeRunIds: ["holder"],
    });
    const expected = await activation.run(() =>
      withContext("activation-agent", () => {
        activateSwarmRun({ groupId: "context", runId: "queued", lifecycleOwner, ...launch });
        return readContext();
      }),
    );
    await activation.drain();
    return expected;
  };
  const close = () => closeSwarmScheduler(lifecycleOwner);
  const dispose = async (pending?: Promise<void>) => {
    await pending?.catch(() => {});
    await Promise.allSettled(tails);
    await close();
    releaseSwarmRun("holder");
  };
  return { activation, observed, tailFailures, trackTail, activate, close, dispose };
}

it.each(["success", "failure"] as const)(
  "runs delayed %s callbacks and joins their work after the activation request retires",
  async (outcome) => {
    const { activation, observed, tailFailures, trackTail, activate, close, dispose } =
      createContextRun();
    const entered = createDeferredCore();
    const launchTail = createDeferredCore();
    const failureEntered = createDeferredCore();
    const failureTail = createDeferredCore();
    const signals: Array<AbortSignal | undefined> = [];
    const failure = new Error("queued launch failed");
    const failures: unknown[] = [];
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      const expected = await activate({
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
      expect(observed).toEqual([]);
      await withContext(
        "release-agent",
        () => expect(releaseSwarmRun("holder")).toBe(true),
        "3",
        "4",
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
      closing = close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      launchTail.resolve();
      failureTail.resolve();
      await closing;
      expect(expected.caller).toBeDefined();
      expect(expected.trace).toBeDefined();
      expect(observed).toEqual(Array(outcome === "failure" ? 4 : 2).fill(expected));
      expect(failures).toEqual(outcome === "failure" ? [failure] : []);
      expect(tailFailures).toEqual([]);
    } finally {
      launchTail.resolve();
      failureTail.resolve();
      await dispose(closing);
    }
  },
);

it.each(["cancelled", "shutdown"] as const)(
  "keeps activation identity and joins fresh cleanup work after %s",
  async (reason) => {
    const { activation, observed, tailFailures, trackTail, activate, close, dispose } =
      createContextRun();
    const entered = createDeferredCore();
    const tail = createDeferredCore();
    const signals: Array<AbortSignal | undefined> = [];
    const reasons: string[] = [];
    let started = false;
    let removal: Promise<void> | undefined;
    let removalSettled = false;
    try {
      const expected = await activate({
        start: async () => {
          started = true;
        },
        onStartFailure: async () => true,
        onRemoved: async (actualReason) => {
          reasons.push(actualReason);
          observed.push(readContext());
          signals.push(getAsyncWorkSignal());
          trackTail(tail.promise);
          entered.resolve();
        },
      });
      await withContext("removal-agent", () => {
        if (reason === "shutdown") {
          removal = close();
        } else {
          const hold = holdQueuedSwarmRun("queued");
          expect(hold?.withdraw()).toBe(true);
          removal = hold?.release();
        }
      });
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
      expect(started).toBe(false);
      expect(isSwarmRunActive("holder")).toBe(true);
      expect(releaseSwarmRun("holder")).toBe(true);
      expect(tailFailures).toEqual([]);
      expect(observed).toEqual([expected, expected]);
    } finally {
      tail.resolve();
      await dispose(removal);
    }
  },
);

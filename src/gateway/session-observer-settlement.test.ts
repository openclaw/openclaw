import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createHarness,
  createObserverTimerTracker,
  declareObserverVisibility,
  flushObserver,
  modelMessage,
  preparedModel,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  resetSessionObserverEventSequence();
});

describe("session observer physical settlement", () => {
  it("waits for an abort-ignoring completion before retrying and never publishes its late result", async ({
    signal,
  }) => {
    const pending = createDeferred<ReturnType<typeof modelMessage>>();
    const completeModel = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(modelMessage({ headline: "Current digest", health: "on-track" }));
    const harness = createHarness({ completeModel });
    const published = createDeferred();
    harness.broadcastToConnIds.mockImplementation(() => published.resolve());
    try {
      startAndAddToolNotes(harness.observer);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(completeModel).toHaveBeenCalledOnce();
      const requestSignal = completeModel.mock.calls[0]?.[0].abortSignal as AbortSignal;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(completeModel).toHaveBeenCalledOnce();
      expect(harness.broadcastToConnIds).not.toHaveBeenCalled();

      pending.resolve(modelMessage({ headline: "Late digest", health: "on-track" }));
      await withinTest(published.promise, signal);
      expect(completeModel).toHaveBeenCalledTimes(2);
      expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
      expect(harness.broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
        headline: "Current digest",
      });
    } finally {
      const disposal = harness.observer.disposeAsync();
      pending.resolve(modelMessage({ headline: "Cleanup", health: "on-track" }));
      await withinTest(disposal, signal);
    }
  });

  it.for(["preparation", "completion"] as const)(
    "joins timed-out %s before asynchronous disposal finishes",
    async (stage, { signal }) => {
      const preparation = createDeferred<ReturnType<typeof preparedModel>>();
      const completion = createDeferred<ReturnType<typeof modelMessage>>();
      const timers = createObserverTimerTracker();
      const harness = createHarness({
        ...timers,
        prepareModel: vi.fn(() =>
          stage === "preparation" ? preparation.promise : Promise.resolve(preparedModel()),
        ),
        completeModel: vi.fn(() => completion.promise),
      });
      let disposed = false;
      let disposal: Promise<void> | undefined;
      try {
        startAndAddToolNotes(harness.observer);
        await vi.advanceTimersByTimeAsync(42_000);
        expect(harness.prepareModel).toHaveBeenCalledOnce();
        expect(harness.completeModel).toHaveBeenCalledTimes(stage === "preparation" ? 0 : 1);
        disposal = harness.observer.disposeAsync().then(() => {
          disposed = true;
        });
        await flushObserver();
        expect(disposed).toBe(false);

        preparation.resolve(preparedModel());
        completion.resolve(modelMessage({ headline: "Late digest", health: "on-track" }));
        await withinTest(disposal, signal);
        expect(disposed).toBe(true);
        expect(harness.completeModel).toHaveBeenCalledTimes(stage === "preparation" ? 0 : 1);
        expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
        expect(timers.ownedTimers.size).toBe(0);
      } finally {
        disposal ??= harness.observer.disposeAsync();
        preparation.resolve(preparedModel());
        completion.resolve(modelMessage({ headline: "Cleanup", health: "on-track" }));
        await withinTest(disposal, signal);
      }
    },
  );

  it.for([
    { kind: "evicted", completion: "physical" },
    { kind: "unsubscribed", completion: "physical" },
    { kind: "replaced", completion: "physical" },
    { kind: "evicted", completion: "logical-result" },
    { kind: "evicted", completion: "logical-error" },
  ] as const)(
    "retains a $kind request's reservation after $completion until physical settlement",
    async ({ kind, completion }, { signal }) => {
      const pending: ReturnType<typeof createDeferred<ReturnType<typeof modelMessage>>>[] = [];
      const signals: AbortSignal[] = [];
      const admitted = createDeferred();
      let active = 0;
      let maximumActive = 0;
      let released = 0;
      let disposed = false;
      let disposal: Promise<void> | undefined;
      const completeModel = vi.fn((params: { abortSignal: AbortSignal }) =>
        runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({
            release: () => {
              released += 1;
            },
          });
          const request = createDeferred<ReturnType<typeof modelMessage>>();
          pending.push(request);
          signals.push(params.abortSignal);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (pending.length === 7) {
            admitted.resolve();
          }
          const physical = request.promise.finally(() => {
            active -= 1;
          });
          void trackAsyncWork(() => physical);
          if (completion === "logical-error") {
            throw new Error("logical completion ended before tracked cleanup");
          }
          return completion === "logical-result"
            ? modelMessage({ headline: "Logical result", health: "on-track" })
            : await physical;
        }),
      );
      const timers = createObserverTimerTracker();
      const harness = createHarness({ subscribe: false, completeModel, ...timers });
      const observe = (index: number) => {
        const sessionKey = `agent:main:session-${index}`;
        const connId = `conn-${index}`;
        harness.subscribers.subscribe(connId, sessionKey)?.commit();
        declareObserverVisibility(harness.observer, connId);
        startAndAddToolNotes(harness.observer, { sessionKey, runId: `run-${index}` });
      };
      try {
        for (let index = 0; index < 6; index += 1) {
          observe(index);
        }
        await vi.advanceTimersByTimeAsync(12_000);
        expect(completeModel).toHaveBeenCalledTimes(6);
        if (kind === "replaced") {
          startAndAddToolNotes(harness.observer, {
            sessionKey: "agent:main:session-0",
            runId: "replacement",
          });
        } else {
          if (kind === "unsubscribed") {
            harness.subscribers.unsubscribe("conn-0", "agent:main:session-0");
          }
          observe(6);
        }
        expect(signals[0]?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(completeModel).toHaveBeenCalledTimes(6);
        expect(active).toBe(6);
        expect(released).toBe(0);

        pending[0]?.resolve(modelMessage({ headline: "Late digest", health: "on-track" }));
        await withinTest(admitted.promise, signal);
        expect(completeModel).toHaveBeenCalledTimes(7);
        expect(active).toBe(6);
        expect(maximumActive).toBe(6);
        expect(released).toBe(1);
        expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
        disposal = harness.observer.disposeAsync().then(() => {
          disposed = true;
        });
        await flushObserver();
        expect(disposed).toBe(false);
      } finally {
        disposal ??= harness.observer.disposeAsync();
        await flushObserver();
        for (const request of pending) {
          request.resolve(modelMessage({ headline: "Cleanup", health: "on-track" }));
        }
        await withinTest(disposal, signal);
        expect(active).toBe(0);
        expect(released).toBe(pending.length);
        expect(timers.ownedTimers.size).toBe(0);
      }
    },
  );
});

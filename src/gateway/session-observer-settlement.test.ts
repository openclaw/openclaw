import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { expectBroadcast, useObserverSuite } from "./session-observer-suite.test-support.js";
import {
  createObserverTimerTracker,
  declareObserverVisibility,
  flushObserver,
  modelMessage,
  preparedModel,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

type Message = ReturnType<typeof modelMessage>;
const message = (headline: string) => modelMessage({ headline, health: "on-track" });
const { createHarness } = useObserverSuite();

it("waits for an abort-ignoring completion before retrying and never publishes its late result", async ({
  signal,
}) => {
  const pending = createDeferred<Message>();
  const completeModel = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(message("Current digest"));
  const harness = createHarness({ completeModel });
  const published = createDeferred();
  harness.broadcastToConnIds.mockImplementation(() => published.resolve());
  try {
    await startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();
    const requestSignal = completeModel.mock.calls[0]?.[0].abortSignal as AbortSignal;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(completeModel).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).not.toHaveBeenCalled();

    pending.resolve(message("Late digest"));
    await withinTest(published.promise, signal);
    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    expectBroadcast(harness, { headline: "Current digest" });
  } finally {
    const disposal = harness.observer.disposeAsync();
    pending.resolve(message("Cleanup"));
    await withinTest(disposal, signal);
  }
});

it.for(["preparation", "completion"] as const)(
  "joins timed-out %s before asynchronous disposal finishes",
  async (stage, { signal }) => {
    const preparation = createDeferred<ReturnType<typeof preparedModel>>();
    const completion = createDeferred<Message>();
    const timers = createObserverTimerTracker();
    const harness = createHarness({
      prepareModel: vi.fn(() =>
        stage === "preparation" ? preparation.promise : Promise.resolve(preparedModel()),
      ),
      completeModel: vi.fn(() => completion.promise),
    });
    const disposed = vi.fn<() => void>();
    let disposal: Promise<void> | undefined;
    try {
      await startAndAddToolNotes(harness.observer);
      await vi.advanceTimersByTimeAsync(42_000);
      expect(harness.prepareModel).toHaveBeenCalledOnce();
      expect(harness.completeModel).toHaveBeenCalledTimes(stage === "preparation" ? 0 : 1);
      disposal = harness.observer.disposeAsync().then(disposed);
      await flushObserver();
      expect(disposed).not.toHaveBeenCalled();

      preparation.resolve(preparedModel());
      completion.resolve(message("Late digest"));
      await withinTest(disposal, signal);
      expect(disposed).toHaveBeenCalledOnce();
      expect(harness.completeModel).toHaveBeenCalledTimes(stage === "preparation" ? 0 : 1);
      expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
      expect(timers.ownedTimers.size).toBe(0);
    } finally {
      disposal ??= harness.observer.disposeAsync();
      preparation.resolve(preparedModel());
      completion.resolve(message("Cleanup"));
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
    const pending: ReturnType<typeof createDeferred<Message>>[] = [];
    const signals: AbortSignal[] = [];
    const admitted = createDeferred();
    const counts = { active: 0, maximumActive: 0, released: 0 };
    const disposed = vi.fn<() => void>();
    let disposal: Promise<void> | undefined;
    const completeModel = vi.fn((params: { abortSignal?: AbortSignal }) =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({
          release: () => {
            counts.released += 1;
          },
        });
        const request = createDeferred<Message>();
        pending.push(request);
        signals.push(params.abortSignal!);
        counts.active += 1;
        counts.maximumActive = Math.max(counts.maximumActive, counts.active);
        if (pending.length === 7) {
          admitted.resolve();
        }
        const physical = request.promise.finally(() => {
          counts.active -= 1;
        });
        void trackAsyncWork(() => physical);
        if (completion === "logical-error") {
          throw new Error("logical completion ended before tracked cleanup");
        }
        return completion === "logical-result" ? message("Logical result") : await physical;
      }),
    );
    const timers = createObserverTimerTracker();
    const harness = createHarness({ subscribe: false, completeModel });
    const observe = async (index: number) => {
      const sessionKey = `agent:main:session-${index}`;
      const connId = `conn-${index}`;
      harness.subscribers.subscribe(connId, sessionKey)?.commit();
      declareObserverVisibility(harness.observer, connId);
      await startAndAddToolNotes(harness.observer, { sessionKey, runId: `run-${index}` });
    };
    try {
      for (let index = 0; index < 6; index += 1) {
        await observe(index);
      }
      await vi.advanceTimersByTimeAsync(12_000);
      expect(completeModel).toHaveBeenCalledTimes(6);
      if (kind === "replaced") {
        await startAndAddToolNotes(harness.observer, {
          sessionKey: "agent:main:session-0",
          runId: "replacement",
        });
      } else {
        if (kind === "unsubscribed") {
          harness.subscribers.unsubscribe("conn-0", "agent:main:session-0");
        }
        await observe(6);
      }
      expect(signals[0]?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(completeModel).toHaveBeenCalledTimes(6);
      expect(counts).toMatchObject({ active: 6, released: 0 });

      pending[0]?.resolve(message("Late digest"));
      await withinTest(admitted.promise, signal);
      expect(completeModel).toHaveBeenCalledTimes(7);
      expect(counts).toEqual({ active: 6, maximumActive: 6, released: 1 });
      expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
      disposal = harness.observer.disposeAsync().then(disposed);
      await flushObserver();
      expect(disposed).not.toHaveBeenCalled();
    } finally {
      disposal ??= harness.observer.disposeAsync();
      await flushObserver();
      for (const request of pending) {
        request.resolve(message("Cleanup"));
      }
      await withinTest(disposal, signal);
      expect(counts).toMatchObject({ active: 0, released: pending.length });
      expect(timers.ownedTimers.size).toBe(0);
    }
  },
);

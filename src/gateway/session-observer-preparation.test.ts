import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { defaultCompleteModel } from "./session-observer-model.js";
import {
  advanceAndFlush as advance,
  expectBroadcast,
  useObserverSuite,
} from "./session-observer-suite.test-support.js";
import {
  event,
  flushObserver,
  preparedModel,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const { createHarness } = useObserverSuite();

it("retries empty visible output without injecting auth into the prepared completion", async () => {
  const digest = { headline: "Reviewing the implementation", health: "on-track" as const };
  const prepared = { ...preparedModel(), provider: "anthropic", model: "claude-sonnet-4-6" };
  const completion = {
    text: JSON.stringify(digest),
    provider: prepared.provider,
    model: prepared.model,
    owner: { kind: "cli" as const, id: "claude-cli" },
  };
  const completeModel = vi
    .fn<typeof defaultCompleteModel>()
    .mockResolvedValueOnce({ ...completion, text: "" })
    .mockResolvedValueOnce(completion);
  const harness = createHarness({ prepareModel: vi.fn(async () => prepared), completeModel });
  await startAndAddToolNotes(harness.observer);
  await advance(12_000);
  expect(completeModel).toHaveBeenCalledTimes(2);
  expect(completeModel.mock.calls[0]?.[0].outputTextPolicy).toBe("strict-visible");
  expect(completeModel.mock.calls[0]?.[0]).not.toHaveProperty("auth");
  expectBroadcast(harness, digest);
});

it.for(["observation ends", "preparation times out"] as const)(
  "does not start completion or another preparation when %s",
  async (outcome, { signal }) => {
    const preparation = createDeferred<ReturnType<typeof preparedModel>>();
    const prepareModel = vi.fn(() => preparation.promise);
    const harness = createHarness({ prepareModel });
    try {
      await startAndAddToolNotes(harness.observer);
      await advance(outcome === "observation ends" ? 12_000 : 42_000);
      expect(prepareModel).toHaveBeenCalledOnce();
      if (outcome === "observation ends") {
        harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
        preparation.resolve(preparedModel());
        await flushObserver();
      }
      expect(harness.completeModel).not.toHaveBeenCalled();
    } finally {
      const disposal = harness.observer.disposeAsync();
      preparation.resolve(preparedModel());
      await withinTest(disposal, signal);
    }
  },
);

it("retries after a rejected preparation", async () => {
  const prepareModel = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary preparation failure"))
    .mockResolvedValue(preparedModel());
  const harness = createHarness({ prepareModel });
  await startAndAddToolNotes(harness.observer);

  await advance(24_000);

  expectBroadcast(harness, { headline: "Reviewing the implementation" });
});

it.each([
  ["claude-cli", "claude-cli", 2],
  [undefined, undefined, 1],
  ["claude-cli", undefined, 2],
] as const)(
  "runtime override %s -> %s prepares %i times across digests",
  async (initial, next, preparations) => {
    let override = initial;
    const prepareModel = vi.fn(async () => ({
      ...preparedModel(),
      ...(override ? { agentHarnessRuntimeOverride: override } : {}),
    }));
    const harness = createHarness({ prepareModel });
    await startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    expect(harness.completeModel.mock.calls[0]?.[0].agentHarnessRuntimeOverride).toBe(initial);
    override = next;
    await harness.observer.handleEventAsync(
      event({ stream: "lifecycle", data: { phase: "end", startedAt: 0, endedAt: 40_000 } }),
    );
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    expect(prepareModel).toHaveBeenCalledTimes(preparations);
    if (!next) {
      expect(harness.completeModel.mock.calls[1]?.[0]).not.toHaveProperty(
        "agentHarnessRuntimeOverride",
      );
    }
  },
);

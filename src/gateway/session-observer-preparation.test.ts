import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import "../agents/utility-completion.js";
import { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";
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

const runtimeMocks = vi.hoisted(() => ({
  selectModel: vi.fn(),
  completeIsolated: vi.fn(),
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: runtimeMocks.selectModel,
}));
vi.mock("../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: runtimeMocks.completeIsolated,
}));

const { createHarness } = useObserverSuite();

it.each(["claude-cli", "anthropic"])(
  "publishes a digest from a runtime-owned %s utility completion after empty output without API auth",
  async (provider) => {
    const config = {
      agents: {
        defaults: {
          utilityModel: `${provider}/claude-sonnet-4-6`,
          models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    };
    runtimeMocks.selectModel.mockReturnValue({
      provider,
      modelId: "claude-sonnet-4-6",
      agentDir: "/tmp/agent",
    });
    const digest = { headline: "Reviewing the implementation", health: "on-track" as const };
    const completion = {
      text: JSON.stringify(digest),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      owner: { kind: "cli", id: "claude-cli" },
    };
    runtimeMocks.completeIsolated
      .mockReset()
      .mockImplementationOnce(async (request) => {
        // The isolated owner rejects empty output unless its caller owns visible-text recovery.
        if (request.outputTextPolicy !== "strict-visible") {
          throw new Error("Isolated completion returned empty output.");
        }
        return { ...completion, text: "" };
      })
      .mockResolvedValueOnce(completion);
    const harness = createHarness({
      config,
      prepareModel: vi.fn(defaultPrepareModel),
      completeModel: vi.fn(defaultCompleteModel),
    });
    await startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    await vi.dynamicImportSettled();
    await flushObserver();

    expect(runtimeMocks.completeIsolated).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.completeIsolated.mock.calls[0]?.[0]).not.toHaveProperty("auth");
    expectBroadcast(harness, digest);
  },
);

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

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as utilityModel from "../agents/utility-model.js";
import * as observerRead from "./session-observer-read.js";
import { useObserverSuite } from "./session-observer-suite.test-support.js";
import * as observerWork from "./session-observer-work.js";
import { event } from "./session-observer.test-utils.js";

const { createHarness } = useObserverSuite();
const stdout = (runId = "run-1") =>
  event({
    runId,
    stream: "tool",
    data: {
      phase: "update",
      outputOnly: true,
      toolCallId: "command",
      partialResult: { text: "out" },
    },
  });

it("does not admit observers from marked stdout or displace an existing run", async () => {
  const harness = createHarness();
  const capture = vi.spyOn(observerRead, "captureSessionObserverRead");
  const resolve = vi.spyOn(utilityModel, "resolveUtilityModelRefForAgent");

  await harness.observer.handleEventAsync(stdout());
  expect(capture).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(harness.readSession).not.toHaveBeenCalled();

  // An unmarked update retains meaningful-event admission, even mid-command.
  await harness.observer.handleEventAsync(
    event({ stream: "tool", data: { phase: "update", partialResult: { text: "legacy" } } }),
  );
  expect(capture).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalled();
  capture.mockClear();
  resolve.mockClear();

  await harness.observer.handleEventAsync(stdout("different-run"));
  expect(capture).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(
    await harness.observer.getCompanionSnapshotAsync("agent:main:session-1", "main"),
  ).toMatchObject({ runId: "run-1" });
});

it("adopts stdout after queued admission, refreshes the live state and drains before disposal", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const captureRead = observerRead.captureSessionObserverRead;
  const capture = vi
    .spyOn(observerRead, "captureSessionObserverRead")
    .mockImplementationOnce((...args) => {
      const reader = captureRead(...args);
      return {
        ...reader,
        async withRead(consume) {
          entered.resolve();
          await release.promise;
          return reader.withRead(consume);
        },
      };
    });
  const work = vi.spyOn(observerWork, "createSessionObserverWork");
  const config = { agents: { defaults: { utilityModel: "openai/gpt-test" } } };
  const harness = createHarness({ config });
  const states = work.mock.calls[0]![0].states;
  const start = harness.observer.handleEventAsync(
    event({ stream: "lifecycle", data: { phase: "start" } }),
  );
  const output = harness.observer.handleEventAsync({ ...stdout(), ts: 500 });
  try {
    await entered.promise;
    expect(states.size).toBe(0);
    release.resolve();
    await Promise.all([start, output]);
    expect(capture).toHaveBeenCalledOnce();
    expect([...states.values()][0]).toMatchObject({ runId: "run-1", lastActivityAt: 500 });

    config.agents.defaults.utilityModel = "openai/gpt-next";
    await harness.observer.handleEventAsync({ ...stdout(), ts: 600 });
    expect([...states.values()][0]).toMatchObject({
      utilityModelRef: "openai/gpt-next",
      lastActivityAt: 600,
    });

    // State existence, rather than its optional reader, controls stdout adoption.
    const state = [...states.values()][0]!;
    const reader = state.reader;
    state.reader = undefined;
    await harness.observer.handleEventAsync({ ...stdout(), ts: 650 });
    expect(state.lastActivityAt).toBe(650);
    expect(capture).toHaveBeenCalledTimes(2);
    state.reader = reader;

    const terminal = harness.observer.handleEventAsync(
      event({ stream: "lifecycle", data: { phase: "end", startedAt: 0, endedAt: 700 } }),
    );
    const stale = harness.observer.handleEventAsync({ ...stdout(), ts: 800 });
    const disposal = harness.observer.disposeAsync();
    await expect(harness.observer.handleEventAsync(stdout())).rejects.toThrow("closed");
    await Promise.all([terminal, stale, disposal]);
    expect(states.size).toBe(0);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(harness.prepareModel).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([start, output]);
  }
});

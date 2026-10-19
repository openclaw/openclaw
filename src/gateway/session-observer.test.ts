import { expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  advanceAndFlush as advance,
  broadcastDigest as lastDigest,
  emitEvent,
  expectBroadcast,
  useObserverSuite,
  type Harness,
  type EventRoute,
} from "./session-observer-suite.test-support.js";
import {
  createObserverTimerTracker,
  declareObserverVisibility,
  flushObserver,
  modelMessage,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const { createHarness, activeHarnesses } = useObserverSuite();

async function preamble(harness: Harness, progressText: string, route: EventRoute = {}) {
  await emitEvent(harness, "item", { kind: "preamble", phase: "update", progressText }, route);
}

async function addToolNotes(harness: Harness, runId = "run-1") {
  for (let index = 0; index < 4; index += 1) {
    await emitEvent(harness, "tool", { phase: "start", name: "read", args: { index } }, { runId });
  }
}

it("keeps global observer streams scoped to their owning agents", async () => {
  vi.setSystemTime(1_000);
  const harness = createHarness({ subscribe: false });
  harness.subscribers.subscribe("conn-main", "agent:main:global")?.commit();
  harness.subscribers.subscribe("conn-legacy", "global")?.commit();
  harness.subscribers.subscribe("conn-work", "agent:work:global")?.commit();
  harness.subscribers.subscribe("conn-work-raw", "global")?.commit();
  declareObserverVisibility(harness.observer, "conn-main");
  declareObserverVisibility(harness.observer, "conn-legacy");
  declareObserverVisibility(harness.observer, "conn-work");
  declareObserverVisibility(harness.observer, "conn-work-raw");

  await preamble(harness, "Main agent work", {
    runId: "run-main",
    sessionKey: "global",
    agentId: "main",
  });
  await preamble(harness, "Work agent task", {
    runId: "run-work",
    sessionKey: "global",
    agentId: "work",
  });
  await flushObserver();

  expect(harness.broadcastToConnIds.mock.calls).toEqual([
    [
      "session.observer",
      expect.objectContaining({ agentId: "main", revision: 1, sessionKey: "global" }),
      new Set(["conn-main", "conn-legacy", "conn-work-raw"]),
      expect.objectContaining({ sessionKeys: ["agent:main:global", "global"] }),
    ],
    [
      "session.observer",
      expect.objectContaining({ agentId: "work", revision: 1, sessionKey: "global" }),
      new Set(["conn-work"]),
      expect.objectContaining({ sessionKeys: ["agent:work:global"] }),
    ],
  ]);
});

it("terminalizes a preamble-only digest without a utility model", async () => {
  const harness = createHarness({ subscribe: false, broadSubscribe: true, utilityModelRef: null });
  await preamble(harness, "**Running** [tests](https://example.com) [[reply_to_current]]");
  expectBroadcast(harness, { headline: "Running tests" }, 0);
  expect(harness.completeModel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  await preamble(harness, "Wrapping up");
  await emitEvent(harness, "lifecycle", { phase: "end", startedAt: 0, endedAt: 40_000 });
  await flushObserver();

  expect(harness.completeModel).not.toHaveBeenCalled();
  expectBroadcast(harness, { headline: "Wrapping up", health: "done", revision: 3 });
  const terminalCount = harness.broadcastToConnIds.mock.calls.length;
  await preamble(harness, "Late preamble");
  await emitEvent(harness, "lifecycle", { phase: "end", startedAt: 0, endedAt: 40_001 });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(terminalCount);
});

it("synthesizes terminal health when the final model request becomes stale", async ({ signal }) => {
  let utilityModelRef: string | undefined = "openai/gpt-a";
  const model = createDeferred<ReturnType<typeof modelMessage>>();
  const harness = createHarness({
    completeModel: vi.fn(() => model.promise),
    resolveUtilityModelRef: vi.fn(() => utilityModelRef),
  });
  await preamble(harness, "Running tests");
  await emitEvent(harness, "lifecycle", { phase: "end", startedAt: 0, endedAt: 40_000 });
  await flushObserver();
  expect(harness.completeModel).toHaveBeenCalledOnce();

  const terminalBroadcast = createDeferred();
  harness.broadcastToConnIds.mockImplementationOnce(() => terminalBroadcast.resolve());
  utilityModelRef = "openai/gpt-b";
  model.resolve(modelMessage({ headline: "Stale final model", health: "done" }));
  await withinTest(terminalBroadcast.promise, signal);

  expectBroadcast(harness, { headline: "Running tests", health: "done", revision: 2 });
});

it("omits tool result bodies while preserving summarized tool arguments", async () => {
  const harness = createHarness();
  const runtimeDetail = "runtime-detail-that-must-not-leave";
  const commandOutput = "command-output-that-must-not-leave";
  const toolCommand = ["password", "test-password"].join("=");

  await emitEvent(harness, "lifecycle", { phase: "start" });
  await emitEvent(harness, "tool", {
    phase: "start",
    name: "exec",
    args: { token: "test-token", command: toolCommand, content: runtimeDetail },
  });
  await emitEvent(harness, "tool", {
    phase: "result",
    result: { content: "ok", details: runtimeDetail },
  });
  await emitEvent(harness, "command_output", {
    phase: "end",
    title: "Command",
    status: "failed",
    exitCode: 1,
    output: commandOutput,
  });
  await emitEvent(harness, "tool", { phase: "start", name: "read", args: { path: "a" } });
  await emitEvent(harness, "tool", { phase: "start", name: "read", args: { path: "b" } });

  await advance(12_000);
  const prompt = String(harness.completeModel.mock.calls[0]?.[0]?.prompt);
  expect(prompt).not.toContain("test-token");
  expect(prompt).not.toContain(runtimeDetail);
  expect(prompt).not.toContain(commandOutput);
  expect(prompt).toContain(toolCommand);
});

it("coalesces live completions and cancels in-flight work for the terminal digest", async ({
  signal,
}) => {
  const first = createDeferred<ReturnType<typeof modelMessage>>();
  const second = createDeferred<ReturnType<typeof modelMessage>>();
  const completeModel = vi
    .fn(async () => modelMessage({ headline: "Continuing the work", health: "on-track" }))
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const harness = createHarness({ completeModel });
  try {
    await startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(completeModel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completeModel).toHaveBeenCalledOnce();

    await addToolNotes(harness);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(completeModel).toHaveBeenCalledOnce();

    first.resolve(modelMessage({ headline: "Starting the work", health: "on-track" }));
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();
    await advance(3_000);
    expect(completeModel).toHaveBeenCalledTimes(2);
    const terminalPublished = createDeferred();
    harness.broadcastToConnIds.mockImplementationOnce(() => terminalPublished.resolve());
    await emitEvent(harness, "lifecycle", { phase: "end", endedAt: 30_000 });
    expect(harness.completeModel.mock.calls[1]?.[0]?.abortSignal.aborted).toBe(true);
    await flushObserver();
    expect(completeModel).toHaveBeenCalledTimes(2);
    second.resolve(modelMessage({ headline: "Canceled live result", health: "on-track" }));
    await withinTest(terminalPublished.promise, signal);
    expect(completeModel).toHaveBeenCalledTimes(3);
    expectBroadcast(harness, { health: "done" });
  } finally {
    first.resolve(modelMessage({ headline: "Cleanup", health: "on-track" }));
    second.resolve(modelMessage({ headline: "Cleanup", health: "on-track" }));
    await harness.observer.disposeAsync();
    activeHarnesses.delete(harness);
  }
});

it("suspends when hidden and resumes on the next event after becoming visible", async () => {
  const harness = createHarness();
  await startAndAddToolNotes(harness.observer);
  await advance(12_000);
  expect(harness.completeModel).toHaveBeenCalledOnce();

  harness.observer.setConnectionVisibility("conn-1", false);
  expect(harness.observer.getCompanionSnapshot("agent:main:session-1").notes).toEqual([]);
  await addToolNotes(harness);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(harness.completeModel).toHaveBeenCalledOnce();

  harness.observer.setConnectionVisibility("conn-1", true);
  await addToolNotes(harness);
  await advance(12_000);

  expect(harness.completeModel).toHaveBeenCalledTimes(2);
});

it("widens only critical health transitions to hidden session-list subscribers", async () => {
  const healths = ["stuck", "stuck", "on-track", "stuck", "done", "failed"] as const;
  const completeModel = vi.fn(async () => {
    const health = healths[completeModel.mock.calls.length - 1] ?? "on-track";
    return modelMessage({ headline: `Health: ${health}`, health });
  });
  const harness = createHarness({ completeModel });
  harness.sessionEventSubscribers.subscribe("conn-background");

  const publishNext = async (initial = false) => {
    if (initial) {
      await startAndAddToolNotes(harness.observer);
    } else {
      await addToolNotes(harness);
    }
    await advance(12_000);
    return harness.broadcastToConnIds.mock.calls.at(-1)?.[2] as ReadonlySet<string>;
  };

  expect(await publishNext(true)).toEqual(new Set(["conn-1", "conn-background"]));
  expect(await publishNext()).toEqual(new Set(["conn-1"]));
  expect(await publishNext()).toEqual(new Set(["conn-1"]));
  expect(await publishNext()).toEqual(new Set(["conn-1", "conn-background"]));
  expect(await publishNext()).toEqual(new Set(["conn-1"]));
  expect(await publishNext()).toEqual(new Set(["conn-1"]));
  expect(completeModel).toHaveBeenCalledTimes(6);
});

it("retries unparseable model JSON and enforces the accepted digest's string caps", async () => {
  const completeModel = vi
    .fn()
    .mockResolvedValueOnce({ ...modelMessage({}), text: "nope" })
    .mockResolvedValueOnce(
      modelMessage({ headline: "h".repeat(140), assessment: "a".repeat(400), health: "on-track" }),
    );
  const harness = createHarness({ completeModel });
  await startAndAddToolNotes(harness.observer);
  await advance(12_000);

  expect(completeModel).toHaveBeenCalledTimes(2);
  expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
  expectBroadcast(harness, { headline: "h".repeat(120), assessment: "a".repeat(320) }, 0);
});

it("demotes the least recently active model while retaining preamble state", async () => {
  const harness = createHarness();
  for (let index = 0; index < 7; index += 1) {
    const sessionKey = `agent:main:session-${index}`;
    harness.subscribers.subscribe(`conn-${index}`, sessionKey)?.commit();
    declareObserverVisibility(harness.observer, `conn-${index}`);
    vi.setSystemTime(index);
    await startAndAddToolNotes(harness.observer, { runId: `run-${index}`, sessionKey });
  }

  await advance(12_000);
  const sessions = harness.broadcastToConnIds.mock.calls.map(
    (call) => (call[1] as SessionObserverDigest).sessionKey,
  );
  expect(sessions).toHaveLength(6);
  expect(sessions).not.toContain("agent:main:session-0");

  const beforePreamble = harness.broadcastToConnIds.mock.calls.length;
  const demoted = { runId: "run-0", sessionKey: "agent:main:session-0" };
  await preamble(harness, "Checking files", demoted);
  await vi.advanceTimersByTimeAsync(100);
  await preamble(harness, "Running", demoted);
  await preamble(harness, "Running tests", demoted);
  expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(beforePreamble + 1);
  await vi.advanceTimersByTimeAsync(1_900);
  expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(beforePreamble + 2);
  expect(lastDigest(harness)?.headline).toBe("Running tests");
});

it("preserves revisions across active and dormant run rollover", async () => {
  const harness = createHarness();
  await startAndAddToolNotes(harness.observer);
  await vi.advanceTimersByTimeAsync(12_000);
  await addToolNotes(harness);
  await advance(12_000);

  await startAndAddToolNotes(harness.observer, { runId: "run-2" });
  await emitEvent(harness, "lifecycle", { phase: "end", endedAt: 30_000 });
  await vi.advanceTimersByTimeAsync(12_000);
  harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
  await emitEvent(harness, "lifecycle", { phase: "start" }, { runId: "run-3" });
  harness.subscribers.subscribe("conn-2", "agent:main:session-1")?.commit();
  declareObserverVisibility(harness.observer, "conn-2");
  await addToolNotes(harness, "run-3");
  await advance(12_000);

  const revisions = harness.broadcastToConnIds.mock.calls.map(
    (call) => (call[1] as SessionObserverDigest).revision,
  );
  expect(revisions).toEqual([1, 2, 3, 4]);
});
it("accepts a model digest after the preamble generation advances", async () => {
  const model = createDeferred<ReturnType<typeof modelMessage>>();
  const completeModel = vi.fn(() => model.promise);
  const harness = createHarness({ completeModel });
  await emitEvent(harness, "lifecycle", { phase: "start" });
  await vi.advanceTimersByTimeAsync(11_500);
  await preamble(harness, "Checking files");
  await vi.advanceTimersByTimeAsync(500);
  await addToolNotes(harness);
  await flushObserver();
  expect(completeModel).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(100);
  await preamble(harness, "Running focused tests");
  model.resolve(modelMessage({ headline: "Stale model summary", health: "on-track" }));
  await flushObserver();
  expectBroadcast(harness, { headline: "Stale model summary" });
  await vi.advanceTimersByTimeAsync(1_900);
  expectBroadcast(harness, { headline: "Stale model summary" });
});

it("stops live model attempts at the budget when requests are superseded", async () => {
  let utilityModelRef = "openai/gpt-a";
  const attempts: ReturnType<typeof createDeferred<ReturnType<typeof modelMessage>>>[] = [];
  const completeModel = vi.fn(() => {
    const attempt = createDeferred<ReturnType<typeof modelMessage>>();
    attempts.push(attempt);
    return attempt.promise;
  });
  const harness = createHarness({
    completeModel,
    resolveUtilityModelRef: vi.fn(() => utilityModelRef),
  });
  await startAndAddToolNotes(harness.observer);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(completeModel).toHaveBeenCalledOnce();

  for (let attempt = 1; attempt <= 39; attempt += 1) {
    utilityModelRef = "openai/gpt-b";
    await emitEvent(harness, "tool", { phase: "start", name: "read", args: { attempt } });
    utilityModelRef = "openai/gpt-a";
    await emitEvent(harness, "tool", { phase: "start", name: "read", args: { attempt } });
    attempts.at(-1)?.resolve(modelMessage({ headline: "Superseded", health: "on-track" }));
    await flushObserver();
    if (attempt === 39) {
      break;
    }
    for (let note = 0; note < 4; note += 1) {
      await emitEvent(harness, "tool", { phase: "start", name: "read", args: { attempt, note } });
    }
    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledTimes(attempt + 1);
  }

  await startAndAddToolNotes(harness.observer, { count: 4 });
  await vi.advanceTimersByTimeAsync(24_000);
  expect(completeModel).toHaveBeenCalledTimes(39);
  completeModel.mockResolvedValue(modelMessage({ headline: "Finished", health: "done" }));
  await emitEvent(harness, "lifecycle", { phase: "end", startedAt: 0, endedAt: Date.now() });
  await flushObserver();
  expect(completeModel).toHaveBeenCalledTimes(40);
  expectBroadcast(harness, { health: "done" });
});

it("disables model work when digest persistence reports a missing entry", async () => {
  const persistDigest = vi.fn(async () => null);
  const unrelated = vi.fn();
  const unrelatedTimer = setTimeout(unrelated, 60_000);
  const { ownedTimers } = createObserverTimerTracker();
  const harness = createHarness({ persistDigest });
  await startAndAddToolNotes(harness.observer);

  await advance(12_000);
  expect(harness.completeModel).toHaveBeenCalledOnce();
  expect(persistDigest).toHaveBeenCalledOnce();
  expect(ownedTimers.size).toBe(0);

  await startAndAddToolNotes(harness.observer, { count: 4 });
  await vi.advanceTimersByTimeAsync(24_000);
  expect(harness.completeModel).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(24_000);
  expect(unrelated).toHaveBeenCalledOnce();
  expect(harness.completeModel).toHaveBeenCalledOnce();
  expect(ownedTimers.size).toBe(0);
  await harness.observer.disposeAsync();
  clearTimeout(unrelatedTimer);
});

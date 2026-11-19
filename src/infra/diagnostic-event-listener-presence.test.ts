import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hasInternalDiagnosticEventInterest as hasInterest,
  hasModelCallPromptStatsInterest as hasPromptStats,
  onInternalDiagnosticEventInterest as onInterest,
} from "./diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent as emit,
  emitTrustedDiagnosticEvent as emitTrusted,
  onInternalDiagnosticEvent as onInternal,
  onTrustedInternalDiagnosticEvent as onTrusted,
  resetDiagnosticEventsForTest as resetEvents,
  waitForDiagnosticEventsDrained as drain,
} from "./diagnostic-events.js";

const queued = "message.queued";
const started = "model.call.started";
const completed = "model.call.completed";
const log = "log.record";
function expectInterests(untrusted: string[], trusted: string[]) {
  const types = [queued, started, completed, log];
  expect(types.filter((type) => hasInterest(type))).toEqual(untrusted);
  expect(types.filter((type) => hasInterest(type, true))).toEqual(trusted);
}

beforeEach(resetEvents);
afterEach(() => {
  resetEvents();
  vi.restoreAllMocks();
});

it("tracks prompt-stat interest through subscriber lifetime", () => {
  const subscribe = onInternal;
  const listener = () => {};
  subscribe(listener, { include: [started, completed], includePromptStats: false });
  expect(hasInterest(started, true)).toBe(true);
  expect(hasPromptStats()).toBe(false);
  subscribe(() => {}, { include: [log] });
  subscribe(() => {}, { includeTrusted: [] });
  expect(hasPromptStats()).toBe(false);
  const stop = subscribe(() => {}, { includeTrusted: [completed] });
  expect(hasPromptStats()).toBe(true);
  stop();
  expect(hasPromptStats()).toBe(false);
  subscribe(listener);
  expect(hasPromptStats()).toBe(true);
  subscribe(listener, { exclude: [started, completed, "model.call.error"] });
  expect(hasPromptStats()).toBe(false);
  const stopBroad = subscribe(listener);
  resetEvents();
  stopBroad();
  expect(hasPromptStats()).toBe(false);
});

it("notifies producers only on new interest, including after reset", () => {
  onInternal(() => {}, { include: [queued] });
  const type = "gateway.event_loop.sample";
  const observations: boolean[] = [];
  const stopObserving = onInterest(type, () => {
    observations.push(hasInterest(type));
  });
  try {
    onInternal(() => {}, { include: ["diagnostic.heartbeat"] });
    onTrusted(() => {}, { exclude: [type] });
    expect(observations).toEqual([]);
    const stopFirst = onInternal(() => {}, { include: [type] });
    const stopSecond = onTrusted(() => {}, { include: [type] });
    expect(observations).toEqual([true]);
    stopFirst();
    expect(observations).toEqual([true]);
    stopSecond();
    expect(observations).toEqual([true]);
    onTrusted(() => {}, { exclude: [log] });
    expect(observations).toEqual([true, true]);
    expect(hasInterest("message.queued")).toBe(true);
    resetEvents();
    const stopAfterReset = onInternal(() => {}, { include: [type] });
    expect(observations).toEqual([true, true, true]);
    stopObserving();
    stopAfterReset();
    onInternal(() => {}, { include: [type] });
    expect(observations).toEqual([true, true, true]);
  } finally {
    stopObserving();
  }
});

it.each([onInternal, onTrusted])(
  "tracks filtered trust across replacement and reset (%#)",
  (subscribe) => {
    const listener = () => {};
    subscribe(listener, {
      includeTrusted: [started, completed, started, log],
      exclude: [log],
    });
    expectInterests([queued, started, completed], [started, completed]);
    const stopUnfiltered = subscribe(() => {});
    expect(hasInterest(log)).toBe(true);
    stopUnfiltered();
    expect(hasInterest(log)).toBe(false);

    const stopOther = subscribe(() => {}, { include: [queued] });
    subscribe(listener, { include: [queued, started], includeTrusted: [started, completed] });
    expectInterests([queued, started], [queued, started]);
    stopOther();
    expect(hasInterest(queued, true)).toBe(false);
    expect(hasInterest(queued)).toBe(true);

    const stopEmpty = subscribe(listener, { includeTrusted: [] });
    expectInterests([queued, started, completed, log], []);
    stopEmpty();
    expectInterests([], []);

    const stopBroad = subscribe(listener);
    expectInterests([queued, started, completed, log], [queued, started, completed, log]);
    resetEvents();
    expectInterests([], []);
    stopBroad();
    expectInterests([], []);
  },
);

it("filters before cloning without trusting public input", async () => {
  const subscribe = onTrusted;
  const seen: Array<{ type: string; trusted: boolean; seq: number }> = [];
  const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
  const clone = vi.spyOn(globalThis, "structuredClone");
  const stop = subscribe(
    (event, metadata) => {
      seen.push({ type: event.type, trusted: metadata.trusted, seq: event.seq });
    },
    { include: [queued, started, log], includeTrusted: [started, log], exclude: [log] },
  );
  emitTrusted({ type: "message.queued", source: "core", trace });
  expect(clone).not.toHaveBeenCalled();
  emit(
    Object.assign({ type: "message.queued" as const, source: "plugin", trace }, { trusted: true }),
  );
  emitTrusted({
    type: "model.call.started",
    runId: "run",
    callId: "call",
    provider: "test",
    model: "test",
    trace,
  });
  emitTrusted({ type: "log.record", level: "INFO", message: "ignored", trace });
  emit({ type: "log.record", level: "INFO", message: "ignored", trace });
  emit({ type: "model.usage", usage: { total: 1 } });
  await drain();

  expect(seen).toEqual([
    { type: "message.queued", trusted: false, seq: 2 },
    { type: "model.call.started", trusted: true, seq: 3 },
  ]);
  expect(clone).toHaveBeenCalledTimes(2);
  stop();
});

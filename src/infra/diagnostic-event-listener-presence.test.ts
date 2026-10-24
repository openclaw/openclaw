import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hasInternalDiagnosticEventInterest,
  hasModelCallPromptStatsInterest,
  onInternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "./diagnostic-events.js";

const queued = "message.queued";
const started = "model.call.started";
const completed = "model.call.completed";
const log = "log.record";
function expectInterests(untrusted: string[], trusted: string[]) {
  const types = [queued, started, completed, log];
  expect(types.filter((type) => hasInternalDiagnosticEventInterest(type))).toEqual(untrusted);
  expect(types.filter((type) => hasInternalDiagnosticEventInterest(type, true))).toEqual(trusted);
}

beforeEach(resetDiagnosticEventsForTest);
afterEach(() => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

it.each([onInternalDiagnosticEvent, onTrustedInternalDiagnosticEvent])(
  "requests prompt stats only for interested subscribers over their lifetime (%#)",
  (subscribe) => {
    const listener = () => {};
    subscribe(listener, { include: [started, completed], includePromptStats: false });
    expect(hasInternalDiagnosticEventInterest(started, true)).toBe(true);
    expect(hasModelCallPromptStatsInterest()).toBe(false);
    subscribe(() => {}, { include: [log] });
    subscribe(() => {}, { includeTrusted: [] });
    expect(hasModelCallPromptStatsInterest()).toBe(false);
    const stop = subscribe(() => {}, { includeTrusted: [completed] });
    expect(hasModelCallPromptStatsInterest()).toBe(true);
    stop();
    expect(hasModelCallPromptStatsInterest()).toBe(false);
    subscribe(listener);
    expect(hasModelCallPromptStatsInterest()).toBe(true);
    subscribe(listener, { exclude: [started, completed, "model.call.error"] });
    expect(hasModelCallPromptStatsInterest()).toBe(false);
    const stopBroad = subscribe(listener);
    resetDiagnosticEventsForTest();
    stopBroad();
    expect(hasModelCallPromptStatsInterest()).toBe(false);
  },
);

it("notifies only newly interested producers across filters, unsubscribe, and reset", () => {
  onInternalDiagnosticEvent(() => {}, { include: [queued] });
  const type = "gateway.event_loop.sample";
  const observations: boolean[] = [];
  const stopObserving = onInternalDiagnosticEventInterest(type, () => {
    observations.push(hasInternalDiagnosticEventInterest(type));
  });
  try {
    onInternalDiagnosticEvent(() => {}, { include: ["diagnostic.heartbeat"] });
    onTrustedInternalDiagnosticEvent(() => {}, { exclude: [type] });
    expect(observations).toEqual([]);
    const stopFirst = onInternalDiagnosticEvent(() => {}, { include: [type] });
    const stopSecond = onTrustedInternalDiagnosticEvent(() => {}, { include: [type] });
    expect(observations).toEqual([true]);
    stopFirst();
    expect(observations).toEqual([true]);
    stopSecond();
    expect(observations).toEqual([true]);
    onTrustedInternalDiagnosticEvent(() => {}, { exclude: [log] });
    expect(observations).toEqual([true, true]);
    expect(hasInternalDiagnosticEventInterest("message.queued")).toBe(true);
    resetDiagnosticEventsForTest();
    const stopAfterReset = onInternalDiagnosticEvent(() => {}, { include: [type] });
    expect(observations).toEqual([true, true, true]);
    stopObserving();
    stopAfterReset();
    onInternalDiagnosticEvent(() => {}, { include: [type] });
    expect(observations).toEqual([true, true, true]);
  } finally {
    stopObserving();
  }
});

it.each([onInternalDiagnosticEvent, onTrustedInternalDiagnosticEvent])(
  "publishes trusted interest across filters, replacement, unsubscribe, and reset (%#)",
  (subscribe) => {
    const listener = () => {};
    subscribe(listener, {
      includeTrusted: [started, completed, started, log],
      exclude: [log],
    });
    expectInterests([queued, started, completed], [started, completed]);
    const stopUnfiltered = subscribe(() => {});
    expect(hasInternalDiagnosticEventInterest(log)).toBe(true);
    stopUnfiltered();
    expect(hasInternalDiagnosticEventInterest(log)).toBe(false);

    const stopOther = subscribe(() => {}, { include: [queued] });
    subscribe(listener, { include: [queued, started], includeTrusted: [started, completed] });
    expectInterests([queued, started], [queued, started]);
    stopOther();
    expect(hasInternalDiagnosticEventInterest(queued, true)).toBe(false);
    expect(hasInternalDiagnosticEventInterest(queued)).toBe(true);

    const stopEmpty = subscribe(listener, { includeTrusted: [] });
    expectInterests([queued, started, completed, log], []);
    stopEmpty();
    expectInterests([], []);

    const stopBroad = subscribe(listener);
    expectInterests([queued, started, completed, log], [queued, started, completed, log]);
    resetDiagnosticEventsForTest();
    expectInterests([], []);
    stopBroad();
    expectInterests([], []);
  },
);

it.each([onInternalDiagnosticEvent, onTrustedInternalDiagnosticEvent])(
  "filters trusted event types before cloning without narrowing untrusted interest (%#)",
  async (subscribe) => {
    const seen: Array<{ type: string; trusted: boolean; seq: number }> = [];
    const clone = vi.spyOn(globalThis, "structuredClone");
    const stop = subscribe(
      (event, metadata) => {
        seen.push({ type: event.type, trusted: metadata.trusted, seq: event.seq });
      },
      { include: [queued, started, log], includeTrusted: [started, log], exclude: [log] },
    );
    expect(hasInternalDiagnosticEventInterest("message.queued")).toBe(true);
    expect(hasInternalDiagnosticEventInterest("log.record")).toBe(false);

    emitTrustedDiagnosticEvent({ type: "message.queued", source: "core" });
    expect(clone).not.toHaveBeenCalled();
    emitDiagnosticEvent(
      Object.assign({ type: "message.queued" as const, source: "plugin" }, { trusted: true }),
    );
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run",
      callId: "call",
      provider: "test",
      model: "test",
    });
    emitTrustedDiagnosticEvent({ type: "log.record", level: "INFO", message: "ignored" });
    emitDiagnosticEvent({ type: "log.record", level: "INFO", message: "ignored" });
    emitDiagnosticEvent({ type: "model.usage", usage: { total: 1 } });
    await waitForDiagnosticEventsDrained();

    expect(seen).toEqual([
      { type: "message.queued", trusted: false, seq: 2 },
      { type: "model.call.started", trusted: true, seq: 3 },
    ]);
    expect(clone).toHaveBeenCalledTimes(2);
    stop();
    expect(hasInternalDiagnosticEventInterest("message.queued")).toBe(false);
  },
);

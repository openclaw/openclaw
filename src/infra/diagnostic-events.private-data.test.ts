import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hasInternalDiagnosticEventInterest,
  hasInternalDiagnosticEventListeners,
} from "./diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";

beforeEach(resetDiagnosticEventsForTest);
afterEach(resetDiagnosticEventsForTest);

it("replaces private-data policy with listener interests and clears it on reset", () => {
  const received = vi.fn();
  const readPrivateData = vi.fn(() => "synthetic private error");
  const emit = () =>
    emitTrustedDiagnosticEventWithPrivateData(
      { type: "model.usage", usage: { input: 1 } },
      {
        get errorMessage() {
          return readPrivateData();
        },
      },
    );
  const stop = onTrustedInternalDiagnosticEvent(received, { include: ["log.record"] });
  onTrustedInternalDiagnosticEvent(
    received,
    { include: ["model.usage"] },
    { includePrivateData: false },
  );
  expect(hasInternalDiagnosticEventInterest("log.record")).toBe(false);
  expect(hasInternalDiagnosticEventInterest("model.usage")).toBe(true);
  emit();
  expect(received.mock.calls[0]?.[2]).toEqual({});
  expect(readPrivateData).not.toHaveBeenCalled();

  onTrustedInternalDiagnosticEvent(received, { include: ["model.usage"] });
  emit();
  expect(received.mock.calls[1]?.[2]).toEqual({ errorMessage: "synthetic private error" });
  expect(readPrivateData).toHaveBeenCalledOnce();
  stop();
  expect(hasInternalDiagnosticEventInterest("model.usage")).toBe(false);
  expect(hasInternalDiagnosticEventListeners()).toBe(false);
  emit();
  expect(received).toHaveBeenCalledTimes(2);

  onTrustedInternalDiagnosticEvent(received, undefined, { includePrivateData: false });
  resetDiagnosticEventsForTest();
  expect(hasInternalDiagnosticEventListeners()).toBe(false);
  const stopAfterReset = onTrustedInternalDiagnosticEvent(received);
  emit();
  expect(received.mock.calls[2]?.[2]).toEqual({ errorMessage: "synthetic private error" });
  expect(readPrivateData).toHaveBeenCalledTimes(2);
  stopAfterReset();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "./diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "./diagnostic-events.js";

describe("diagnostic event listener interest", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });
  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  it("applies internal listener interests before dispatch", async () => {
    const included: string[] = [];
    const excluded: string[] = [];
    onInternalDiagnosticEvent((event) => included.push(event.type), {
      include: ["message.queued"],
    });
    onTrustedInternalDiagnosticEvent((event) => excluded.push(event.type), {
      exclude: ["log.record"],
    });

    emitDiagnosticEvent({ type: "message.queued", source: "plugin" });
    emitDiagnosticEvent({ type: "log.record", level: "INFO", message: "ignored" });
    await waitForDiagnosticEventsDrained();

    expect(included).toEqual(["message.queued"]);
    expect(excluded).toEqual(["message.queued"]);
  });

  it("tracks broad, included, and excluded event interest through unsubscribe and reset", () => {
    const stopBroad = onInternalDiagnosticEvent(() => undefined);
    expect(hasInternalDiagnosticEventInterest("log.record")).toBe(true);
    stopBroad();
    expect(hasInternalDiagnosticEventInterest("log.record")).toBe(false);

    const stopIncluded = onInternalDiagnosticEvent(() => undefined, {
      include: ["message.queued", "log.record"],
      exclude: ["log.record"],
    });
    expect(hasInternalDiagnosticEventInterest("message.queued")).toBe(true);
    expect(hasInternalDiagnosticEventInterest("log.record")).toBe(false);

    resetDiagnosticEventsForTest();
    expect(hasInternalDiagnosticEventInterest("message.queued")).toBe(false);
    stopIncluded();
  });

  it.each([onInternalDiagnosticEvent, onTrustedInternalDiagnosticEvent])(
    "filters trusted event types before cloning without narrowing untrusted interest (%#)",
    async (subscribe) => {
      const seen: Array<{ type: string; trusted: boolean; seq: number }> = [];
      const clone = vi.spyOn(globalThis, "structuredClone");
      const stop = subscribe(
        (event, metadata) => {
          seen.push({ type: event.type, trusted: metadata.trusted, seq: event.seq });
        },
        {
          include: ["message.queued", "model.call.started", "log.record"],
          includeTrusted: ["model.call.started", "log.record"],
          exclude: ["log.record"],
        },
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
});

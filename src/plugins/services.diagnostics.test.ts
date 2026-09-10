import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { startPluginServices } from "./services.js";
import type { OpenClawPluginService } from "./types.js";

beforeEach(resetDiagnosticEventsForTest);
afterEach(resetDiagnosticEventsForTest);

it.each([undefined, false])(
  "retains filtered diagnostic interests and private policy (%s) for the exporter lifetime",
  async (includePrivateData) => {
    const received = vi.fn();
    const readPrivateData = vi.fn(() => "synthetic private error");
    const service: OpenClawPluginService = {
      id: "diagnostics-otel",
      start: (ctx) => {
        ctx.internalDiagnostics!.onEvent(
          received,
          { include: ["log.record"] },
          { includePrivateData },
        );
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.services.push({ pluginId: service.id, origin: "bundled", source: "test", service });
    const handle = await startPluginServices({ registry, config: {} });
    try {
      expect(hasInternalDiagnosticEventInterest("log.record")).toBe(true);
      expect(hasInternalDiagnosticEventInterest("gateway.event_loop.sample")).toBe(false);
      expect(hasInternalDiagnosticEventInterest("gateway.rpc")).toBe(false);
      emitTrustedDiagnosticEventWithPrivateData(
        { type: "log.record", level: "INFO", message: "synthetic" },
        {
          get errorMessage() {
            return readPrivateData();
          },
        },
      );
      emitTrustedDiagnosticEvent({ type: "gateway.rpc", phase: "received", method: "health" });
      emitTrustedDiagnosticEvent({
        type: "gateway.event_loop.sample",
        intervalMs: 1_000,
        delayMaxMs: 1_500,
      });
      await waitForDiagnosticEventsDrained();
      expect(received.mock.calls.map(([event]) => event.type)).toEqual(["log.record"]);
      expect(readPrivateData).toHaveBeenCalledTimes(includePrivateData === false ? 0 : 1);
      expect(received.mock.calls[0]?.[2]).toEqual(
        includePrivateData === false ? {} : { errorMessage: "synthetic private error" },
      );
      expect(Object.isFrozen(received.mock.calls[0]?.[2])).toBe(true);
    } finally {
      await handle.stop();
    }
    expect(hasInternalDiagnosticEventInterest("log.record")).toBe(false);
    expect(hasInternalDiagnosticEventInterest("gateway.event_loop.sample")).toBe(false);
    expect(hasInternalDiagnosticEventInterest("gateway.rpc")).toBe(false);
  },
);

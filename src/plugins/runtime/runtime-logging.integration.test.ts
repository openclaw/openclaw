// Runtime logging integration tests cover real diagnostic log event output.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createRuntimeLogging } from "./runtime-logging.js";

const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
let unsubscribe: (() => void) | undefined;

function emitRuntimePluginWarning() {
  createRuntimeLogging()
    .getChildLogger({ plugin: "discord" })
    .warn("plugin warning", { status: "skipped" });
}

beforeEach(() => {
  received.length = 0;
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info" });
  unsubscribe = onInternalDiagnosticEvent((evt) => {
    if (evt.type === "log.record") {
      received.push(evt);
    }
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  received.length = 0;
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("createRuntimeLogging diagnostic output", () => {
  it("emits plugin caller source semantics through real diagnostic log events", async () => {
    emitRuntimePluginWarning();
    await waitForDiagnosticEventsDrained();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event?.category).toBe("discord");
    expect(event?.code?.functionName).toContain("emitRuntimePluginWarning");
    expect(event?.code?.siteId).toMatch(/^[0-9a-f]{16}$/u);
    expect(event?.attributes?.["__openclawDiagnosticLogSource"]).toBeUndefined();
  });

  it("emits explicit plugin runtime log semantics through real diagnostic log events", async () => {
    createRuntimeLogging().getChildLogger({ plugin: "discord" }).warn(
      "plugin warning",
      { status: "skipped" },
      {
        event: "plugins.discord.monitor.skipped",
        category: "plugins.discord.monitor",
        outcome: "warning",
        reason: "not_ready",
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event?.event).toBe("plugins.discord.monitor.skipped");
    expect(event?.category).toBe("plugins.discord.monitor");
    expect(event?.outcome).toBe("warning");
    expect(event?.reason).toBe("not_ready");
    expect(event?.attributes?.status).toBe("skipped");
    expect(event?.attributes?.["__openclawDiagnosticLogSemantics"]).toBeUndefined();
  });
});

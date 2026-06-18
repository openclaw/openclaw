import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { measureReplyPhaseDiagnostics } from "./reply-phase-diagnostics.js";

function diagnosticsConfig(enabled = true): OpenClawConfig {
  return { diagnostics: { enabled } } as OpenClawConfig;
}

describe("measureReplyPhaseDiagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  async function collectReplyPhaseEvents(run: () => Promise<void>) {
    const events: Extract<DiagnosticEventPayload, { type: "reply.phase.completed" }>[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "reply.phase.completed") {
        events.push(event);
      }
    });
    try {
      await run();
      await waitForDiagnosticEventsDrained();
      return events;
    } finally {
      stop();
    }
  }

  it("emits completed events for allowlisted reply phases", async () => {
    const events = await collectReplyPhaseEvents(async () => {
      await expect(
        measureReplyPhaseDiagnostics("reply.build_prompt_bodies", () => "ok", {
          channel: "telegram",
          config: diagnosticsConfig(),
          model: "gpt-5.5",
          provider: "openai",
          sessionKey: "session-key",
        }),
      ).resolves.toBe("ok");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "reply.phase.completed",
      phase: "reply.build_prompt_bodies",
      phaseGroup: "pre_model",
      outcome: "completed",
      channel: "telegram",
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: "session-key",
    });
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits error events before rethrowing", async () => {
    const error = new TypeError("bad phase");
    const events = await collectReplyPhaseEvents(async () => {
      await expect(
        measureReplyPhaseDiagnostics(
          "reply.memory_flush",
          () => {
            throw error;
          },
          {
            config: diagnosticsConfig(),
          },
        ),
      ).rejects.toBe(error);
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "reply.memory_flush",
      phaseGroup: "pre_model",
      outcome: "error",
      errorCategory: "TypeError",
    });
  });

  it("does not emit events for aggregate wrapper names or disabled diagnostics", async () => {
    const events = await collectReplyPhaseEvents(async () => {
      await measureReplyPhaseDiagnostics("reply.run_prepared_reply", () => "aggregate", {
        config: diagnosticsConfig(),
      });
      await measureReplyPhaseDiagnostics("reply.build_prompt_bodies", () => "disabled", {
        config: diagnosticsConfig(false),
      });
    });

    expect(events).toEqual([]);
  });
});

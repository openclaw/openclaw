import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";
import {
  clearBusyMessageOutcomeStoreForTest,
  recordBusyMessageOutcome,
} from "./queue/busy-message-outcome.js";

describe("maybeHandleQueueDirective", () => {
  afterEach(() => {
    clearBusyMessageOutcomeStoreForTest();
  });

  it("reports invalid queue options and current queue settings", () => {
    const invalid = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue collect debounce:bogus cap:zero drop:maybe"),
      cfg: {} as OpenClawConfig,
      channel: "quietchat",
    });
    expect(invalid?.text).toContain("Invalid debounce");
    expect(invalid?.text).toContain("Invalid cap");
    expect(invalid?.text).toContain("Invalid drop policy");

    const invalidMode = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue backlog"),
      cfg: {} as OpenClawConfig,
      channel: "quietchat",
    });
    expect(invalidMode?.text).toContain(
      'Unrecognized queue mode "backlog". Valid modes: steer, followup, collect, interrupt.',
    );

    const current = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {
        messages: {
          queue: {
            mode: "collect",
            debounceMs: 1500,
            cap: 9,
            drop: "summarize",
          },
        },
      } as OpenClawConfig,
      channel: "quietchat",
    });
    expect(current?.text).toContain(
      "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
    );
    expect(current?.text).toContain("Last busy message: none.");
    expect(current?.text).toContain(
      "Options: modes steer, followup, collect, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
    );
  });

  it("appends last busy-message outcome to /queue status", () => {
    recordBusyMessageOutcome({
      kind: "active_run_steer_accepted",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      queueMode: "steer",
    });

    const steered = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      sessionKey: "agent:main:main",
    });
    expect(steered?.text).toContain("Last busy message: steered into active run.");

    clearBusyMessageOutcomeStoreForTest();
    recordBusyMessageOutcome({
      kind: "active_run_steer_rejected",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      queueMode: "steer",
      reason: "compacting",
    });

    const rejected = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      sessionKey: "agent:main:main",
    });
    expect(rejected?.text).toContain("Last busy message: steering rejected (compacting).");

    clearBusyMessageOutcomeStoreForTest();
    recordBusyMessageOutcome({
      kind: "followup_enqueued",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      queueMode: "steer",
    });

    const fallback = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      sessionKey: "agent:main:main",
    });
    expect(fallback?.text).toContain("Last busy message: queued follow-up (steering unavailable).");

    clearBusyMessageOutcomeStoreForTest();
    recordBusyMessageOutcome({
      kind: "followup_enqueued",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      queueMode: "followup",
    });

    const followup = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      sessionKey: "agent:main:main",
    });
    expect(followup?.text).toContain("Last busy message: queued follow-up.");
  });

  it.each(["cap:1e3", "cap:0x10", "cap:4.9"])("rejects non-decimal-integer caps: %s", (cap) => {
    const invalid = maybeHandleQueueDirective({
      directives: parseInlineDirectives(`/queue collect ${cap}`),
      cfg: {} as OpenClawConfig,
      channel: "quietchat",
    });

    expect(invalid?.text).toContain("Invalid cap");
  });
});

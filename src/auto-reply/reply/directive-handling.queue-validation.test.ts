import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";

function queue(command: string, cfg: OpenClawConfig = {}) {
  return maybeHandleQueueDirective({
    directives: parseInlineSessionDirectives(command),
    cfg,
    channel: "quietchat",
  })?.text;
}

describe("maybeHandleQueueDirective", () => {
  it("reports invalid queue options and current queue settings", () => {
    const invalid = queue("/queue collect debounce:bogus cap:zero drop:maybe");
    expect(invalid).toContain("Invalid debounce");
    expect(invalid).toContain("Invalid cap");
    expect(invalid).toContain("Invalid drop policy");
    expect(queue("/queue backlog")).toContain(
      'Unrecognized queue mode "backlog". Valid modes: steer, followup, collect, interrupt.',
    );
    const current = queue("/queue", {
      messages: { queue: { mode: "collect", cap: 9, drop: "summarize" } },
    });
    expect(current).toContain(
      "Current queue settings: mode=collect, debounce=500ms, cap=9, drop=summarize.",
    );
    expect(current).toContain(
      "Options: modes steer, followup, collect, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
    );
  });

  it("rejects a numeric-looking cap that is not a decimal integer", () => {
    expect(queue("/queue collect cap:1e3")).toContain("Invalid cap");
  });
});

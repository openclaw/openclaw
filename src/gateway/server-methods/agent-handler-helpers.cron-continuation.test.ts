import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { cronContinuationHasReusableRuntime } from "./agent-handler-helpers.js";

describe("cron continuation runtime reuse", () => {
  it("does not require a stale CLI binding when native authority is disabled", () => {
    const params = {
      cfg: {},
      entry: { sessionId: "session-1", updatedAt: 1 } as SessionEntry,
      agentId: "main",
      provider: "claude-cli",
      model: "claude-opus-4-8",
    };

    expect(
      cronContinuationHasReusableRuntime({
        ...params,
        scheduledNativePolicy: { version: 1, mode: "disabled" },
      }),
    ).toBe(true);
    expect(
      cronContinuationHasReusableRuntime({
        ...params,
        scheduledNativePolicy: { version: 1, mode: "inherit" },
      }),
    ).toBe(false);
  });
});

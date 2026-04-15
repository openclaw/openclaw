import { describe, expect, it } from "vitest";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";

describe("shouldReloadHistoryForFinalEvent", () => {
  it("returns false for non-final events", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      }),
    ).toBe(false);
  });

  it("returns true when final event has no message payload", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
      }),
    ).toBe(true);
  });

  it("returns false when the final event completes the tracked run", () => {
    expect(
      shouldReloadHistoryForFinalEvent(
        {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
        { trackedRunId: "run-1" },
      ),
    ).toBe(false);
  });

  it("returns true when final event includes assistant payload for a different run", () => {
    expect(
      shouldReloadHistoryForFinalEvent(
        {
          runId: "run-2",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
        { trackedRunId: "run-1" },
      ),
    ).toBe(true);
  });

  it("returns true when final event message role is non-assistant", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: { role: "user", content: [{ type: "text", text: "echo" }] },
      }),
    ).toBe(true);
  });
});

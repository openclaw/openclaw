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

  it("returns false for undefined payload", () => {
    expect(shouldReloadHistoryForFinalEvent(undefined)).toBe(false);
  });

  it("returns false for final assistant message without media", () => {
    expect(
      shouldReloadHistoryForFinalEvent(
        {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
        false,
      ),
    ).toBe(false);
  });

  it("returns true for final event with media flag set", () => {
    expect(
      shouldReloadHistoryForFinalEvent(
        {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
        true,
      ),
    ).toBe(true);
  });

  it("returns true for final event with no message (cross-run reload)", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
      }),
    ).toBe(true);
  });

  it("returns true for final event with no message even without media", () => {
    expect(
      shouldReloadHistoryForFinalEvent(
        { runId: "run-1", sessionKey: "main", state: "final" },
        false,
      ),
    ).toBe(true);
  });

  it("returns true for final event with non-assistant role", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: { role: "system", content: [{ type: "text", text: "info" }] },
      }),
    ).toBe(true);
  });
});

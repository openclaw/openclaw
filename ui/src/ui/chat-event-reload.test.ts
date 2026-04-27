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

  it("returns false when final event includes renderable assistant payload", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ).toBe(false);
  });

  it("returns false when final event includes a legacy assistant text payload without role", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: { text: "done" },
      }),
    ).toBe(false);
  });

  it.each(["NO_REPLY", "no_reply", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "returns true when final event includes silent assistant payload %s",
    (text) => {
      expect(
        shouldReloadHistoryForFinalEvent({
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      ).toBe(true);
    },
  );

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

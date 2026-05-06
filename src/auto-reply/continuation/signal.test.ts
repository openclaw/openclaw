import { describe, expect, it } from "vitest";
import { extractContinuationSignal } from "./signal.js";

describe("extractContinuationSignal", () => {
  it("returns null when disabled", () => {
    const result = extractContinuationSignal({
      payloads: [{ text: "reply\nCONTINUE_WORK" }],
      enabled: false,
    });
    expect(result.signal).toBeNull();
  });

  it("extracts bracket signal from last text payload", () => {
    const payloads = [{ text: "Here is my reply.\n\n[[CONTINUE_DELEGATE: check status]]" }];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
      sessionKey: "test",
    });
    expect(result.signal?.kind).toBe("delegate");
    expect(result.fromBracket).toBe(true);
    // Text should be stripped
    expect(payloads[0].text).toBe("Here is my reply.");
  });

  it("extracts CONTINUE_WORK from text", () => {
    const payloads = [{ text: "Done for now.\nCONTINUE_WORK:30" }];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
    });
    expect(result.signal).toEqual({ kind: "work", delayMs: 30_000 });
    expect(result.fromBracket).toBe(true);
  });

  it("falls back to tool-call request when no bracket signal", () => {
    const result = extractContinuationSignal({
      payloads: [{ text: "Normal reply." }],
      continueWorkRequest: { reason: "more to do", delaySeconds: 15 },
      enabled: true,
    });
    expect(result.signal).toEqual({ kind: "work", delayMs: 15_000 });
    expect(result.fromBracket).toBe(false);
    expect(result.workReason).toBe("more to do");
  });

  it("bracket signal takes precedence over tool-call request", () => {
    const payloads = [{ text: "reply\nCONTINUE_WORK:5" }];
    const result = extractContinuationSignal({
      payloads,
      continueWorkRequest: { reason: "tool", delaySeconds: 60 },
      enabled: true,
    });
    // Bracket wins
    expect(result.signal).toEqual({ kind: "work", delayMs: 5_000 });
    expect(result.fromBracket).toBe(true);
    expect(result.workReason).toBeUndefined();
  });

  it("handles empty payloads", () => {
    const result = extractContinuationSignal({
      payloads: [],
      enabled: true,
    });
    expect(result.signal).toBeNull();
  });

  it("scans backward through payloads to find last text", () => {
    const payloads = [
      { text: "First reply with bracket\n[[CONTINUE_DELEGATE: old task]]" },
      { toolCall: true }, // non-text payload
      { text: "Latest reply\n[[CONTINUE_DELEGATE: real task]]" },
    ];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
    });
    expect(result.signal?.kind).toBe("delegate");
    if (result.signal?.kind === "delegate") {
      expect(result.signal.task).toBe("real task");
    }
  });
});

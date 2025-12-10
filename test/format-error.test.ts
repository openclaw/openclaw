import { describe, expect, it } from "vitest";
import { formatError } from "../apps/macos/Sources/Clawdis/Resources/WebChat/format-error.js";

describe("formatError", () => {
  it("handles Error with stack", () => {
    const err = new Error("boom");
    err.stack = "stack trace";
    expect(formatError(err)).toBe("stack trace");
  });

  it("handles CloseEvent-like object", () => {
    const err = { code: 1006, reason: "socket closed", wasClean: false };
    expect(formatError(err)).toBe("WebSocket closed (1006); reason: socket closed");
  });

  it("handles WebSocket error event with state", () => {
    const err = { type: "error", target: { readyState: 2 } };
    expect(formatError(err)).toBe("WebSocket error (state: closing)");
  });

  it("stringifies plain objects", () => {
    expect(formatError({ a: 1 })).toBe("{\"a\":1}");
  });

  it("falls back to string", () => {
    const circular = {} as any;
    circular.self = circular;
    expect(formatError(circular)).toBe("[object Object]");
  });
});

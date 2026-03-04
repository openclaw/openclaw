import { describe, expect, it } from "vitest";
import { validateWakeParams } from "./index.js";

describe("validateWakeParams", () => {
  it("accepts valid params without sessionKey", () => {
    expect(validateWakeParams({ mode: "now", text: "hello" })).toBe(true);
    expect(validateWakeParams({ mode: "next-heartbeat", text: "hi" })).toBe(true);
  });

  it("accepts valid params with sessionKey", () => {
    expect(
      validateWakeParams({ mode: "now", text: "hello", sessionKey: "discord:channel:123" }),
    ).toBe(true);
  });

  it("rejects empty string sessionKey", () => {
    expect(validateWakeParams({ mode: "now", text: "hello", sessionKey: "" })).toBe(false);
  });

  it("rejects missing text", () => {
    expect(validateWakeParams({ mode: "now" })).toBe(false);
  });

  it("rejects empty text", () => {
    expect(validateWakeParams({ mode: "now", text: "" })).toBe(false);
  });

  it("rejects invalid mode", () => {
    expect(validateWakeParams({ mode: "invalid", text: "hello" })).toBe(false);
  });

  it("rejects non-string sessionKey", () => {
    expect(validateWakeParams({ mode: "now", text: "hello", sessionKey: 123 })).toBe(false);
  });

  it("rejects additional properties", () => {
    expect(validateWakeParams({ mode: "now", text: "hello", extra: true })).toBe(false);
  });
});

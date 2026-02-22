import { describe, it, expect } from "vitest";
import { resolveSignalSender } from "../identity.js";

describe("Signal Reaction Handler (Sender Resolution)", () => {
  it("should resolve sender from sourceNumber", () => {
    const sender = resolveSignalSender({ sourceNumber: "+1234567890" });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+1234567890",
      e164: "+1234567890",
    });
  });

  it("should resolve sender from source (legacy field)", () => {
    // This simulates older signal-cli versions or cases where 'source' is used instead of sourceNumber
    const sender = resolveSignalSender({ source: "+1987654321" });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+1987654321",
      e164: "+1987654321",
    });
  });

  it("should prioritize sourceNumber over source if both present", () => {
    const sender = resolveSignalSender({
      sourceNumber: "+1111111111",
      source: "+2222222222",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+1111111111",
      e164: "+1111111111",
    });
  });

  it("should resolve sender from sourceUuid", () => {
    const sender = resolveSignalSender({ sourceUuid: "uuid-123" });
    expect(sender).toEqual({ kind: "uuid", raw: "uuid-123" });
  });

  it("should return null if neither present", () => {
    const sender = resolveSignalSender({});
    expect(sender).toBeNull();
  });
});

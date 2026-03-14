import { describe, expect, it } from "vitest";
import {
  ambiguousTargetError,
  ambiguousTargetMessage,
  missingTargetError,
  missingTargetMessage,
  unknownTargetError,
  unknownTargetMessage,
} from "./target-errors.js";

describe("target error helpers", () => {
  it("formats missing-target messages with and without hints", () => {
    expect(missingTargetMessage("Slack")).toBe("Delivering to Slack requires target");
    expect(missingTargetMessage("Slack", "Use channel:C123")).toBe(
      "Delivering to Slack requires target Use channel:C123",
    );
    expect(missingTargetError("Slack", "Use channel:C123").message).toBe(
      "Delivering to Slack requires target Use channel:C123",
    );
  });

  it("treats blank hints the same as no hint", () => {
    expect(missingTargetMessage("Slack", "   ")).toBe("Delivering to Slack requires target");
    expect(ambiguousTargetMessage("Discord", "general", "   ")).toBe(
      'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    );
    expect(unknownTargetMessage("Discord", "general", "   ")).toBe(
      'Unknown target "general" for Discord.',
    );
  });

  it("formats ambiguous and unknown target messages with labeled hints", () => {
    expect(ambiguousTargetMessage("Discord", "general")).toBe(
      'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    );
    expect(ambiguousTargetMessage("Discord", "general", "Use channel:123")).toBe(
      'Ambiguous target "general" for Discord. Provide a unique name or an explicit id. Hint: Use channel:123',
    );
    expect(unknownTargetMessage("Discord", "general", "Use channel:123")).toBe(
      'Unknown target "general" for Discord. Hint: Use channel:123',
    );
    expect(ambiguousTargetError("Discord", "general", "Use channel:123").message).toContain(
      "Hint: Use channel:123",
    );
    expect(unknownTargetError("Discord", "general").message).toBe(
      'Unknown target "general" for Discord.',
    );
  });

  it("trims non-blank hints before formatting them", () => {
    expect(missingTargetMessage("Slack", "  Use channel:C123  ")).toBe(
      "Delivering to Slack requires target Use channel:C123",
    );
    expect(unknownTargetMessage("Discord", "general", "  Use channel:123  ")).toBe(
      'Unknown target "general" for Discord. Hint: Use channel:123',
    );
  });
});

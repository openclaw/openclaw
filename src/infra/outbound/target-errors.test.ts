// Covers user-facing target error messages and hint formatting.
import { describe, expect, it } from "vitest";
import {
  ambiguousTargetError,
  ambiguousTargetMessage,
  isReservedTargetMetaString,
  missingTargetError,
  missingTargetMessage,
  reservedTargetMetaStringError,
  reservedTargetMetaStringMessage,
  RESERVED_TARGET_META_STRINGS,
  unknownTargetError,
  unknownTargetMessage,
} from "./target-errors.js";

describe("target error helpers", () => {
  it.each([
    {
      actual: missingTargetMessage("Slack"),
      expected: "Delivering to Slack requires target",
    },
    {
      actual: missingTargetMessage("Slack", "Use channel:C123"),
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: missingTargetError("Slack", "Use channel:C123").message,
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: missingTargetMessage("Slack", "   "),
      expected: "Delivering to Slack requires target",
    },
    {
      actual: ambiguousTargetMessage("Discord", "general", "   "),
      expected: 'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    },
    {
      actual: unknownTargetMessage("Discord", "general", "   "),
      expected: 'Unknown target "general" for Discord.',
    },
    {
      actual: ambiguousTargetMessage("Discord", "general"),
      expected: 'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    },
    {
      actual: ambiguousTargetMessage("Discord", "general", "Use channel:123"),
      expected:
        'Ambiguous target "general" for Discord. Provide a unique name or an explicit id. Hint: Use channel:123',
    },
    {
      actual: unknownTargetMessage("Discord", "general", "Use channel:123"),
      expected: 'Unknown target "general" for Discord. Hint: Use channel:123',
    },
    {
      actual: unknownTargetError("Discord", "general").message,
      expected: 'Unknown target "general" for Discord.',
    },
    {
      actual: missingTargetMessage("Slack", "  Use channel:C123  "),
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: unknownTargetMessage("Discord", "general", "  Use channel:123  "),
      expected: 'Unknown target "general" for Discord. Hint: Use channel:123',
    },
  ])("formats target error helper output for %j", ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });

  it("includes the hint in ambiguous target errors", () => {
    expect(ambiguousTargetError("Discord", "general", "Use channel:123").message).toContain(
      "Hint: Use channel:123",
    );
  });

  describe("reserved target meta-strings", () => {
    it("identifies reserved meta-strings (case-insensitive)", () => {
      expect(isReservedTargetMetaString("current")).toBe(true);
      expect(isReservedTargetMetaString("CURRENT")).toBe(true);
      expect(isReservedTargetMetaString("  current  ")).toBe(true);
      expect(isReservedTargetMetaString("self")).toBe(true);
      expect(isReservedTargetMetaString("Self")).toBe(true);
      expect(isReservedTargetMetaString("this")).toBe(true);
      expect(isReservedTargetMetaString("THIS")).toBe(true);
      expect(isReservedTargetMetaString("me")).toBe(true);
      expect(isReservedTargetMetaString("ME")).toBe(true);
    });

    it("rejects non-reserved strings", () => {
      expect(isReservedTargetMetaString("my-room")).toBe(false);
      expect(isReservedTargetMetaString("@channel")).toBe(false);
      expect(isReservedTargetMetaString("current-room")).toBe(false);
      expect(isReservedTargetMetaString("selfie")).toBe(false);
      expect(isReservedTargetMetaString("")).toBe(false);
      expect(isReservedTargetMetaString("   ")).toBe(false);
    });

    it("formats reserved target error message", () => {
      expect(reservedTargetMetaStringMessage("current")).toBe(
        'Resolver: reserved meta-string "current" cannot be a literal target. Use explicit { chatId, threadId } instead.',
      );
      expect(reservedTargetMetaStringMessage("CURRENT")).toBe(
        'Resolver: reserved meta-string "CURRENT" cannot be a literal target. Use explicit { chatId, threadId } instead.',
      );
    });

    it("creates reserved target error", () => {
      const error = reservedTargetMetaStringError("current");
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("reserved meta-string");
      expect(error.message).toContain("current");
    });

    it("exports the complete list of reserved strings", () => {
      expect(RESERVED_TARGET_META_STRINGS).toContain("current");
      expect(RESERVED_TARGET_META_STRINGS).toContain("self");
      expect(RESERVED_TARGET_META_STRINGS).toContain("this");
      expect(RESERVED_TARGET_META_STRINGS).toContain("me");
      expect(RESERVED_TARGET_META_STRINGS.length).toBe(4);
    });
  });
});

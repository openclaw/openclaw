import { describe, expect, it } from "vitest";
import {
  ambiguousTargetError,
  ambiguousTargetMessage,
  isOutboundDispatchTerminalError,
  missingTargetError,
  missingTargetMessage,
  OutboundDispatchTerminalError,
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
});

describe("OutboundDispatchTerminalError", () => {
  it("is detected through instanceof checks", () => {
    const err = new OutboundDispatchTerminalError("listener offline", "listener-down");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OutboundDispatchTerminalError);
    expect(err.name).toBe("OutboundDispatchTerminalError");
    expect(err.reason).toBe("listener-down");
    expect(err.message).toBe("listener offline");
  });

  it("is detected through isOutboundDispatchTerminalError", () => {
    const err = new OutboundDispatchTerminalError("x", "r");
    expect(isOutboundDispatchTerminalError(err)).toBe(true);
  });

  it(
    "detects cross-bundle copies via the .name + .reason shape, since plugins " +
      "may carry their own copy of the class",
    () => {
      // Simulate a plugin that bundles its own copy of the class — same name,
      // same shape, but a different prototype chain.
      const stand_in = new Error("listener offline") as Error & { reason: string };
      stand_in.name = "OutboundDispatchTerminalError";
      stand_in.reason = "whatsapp-listener-unavailable";
      expect(stand_in instanceof OutboundDispatchTerminalError).toBe(false);
      expect(isOutboundDispatchTerminalError(stand_in)).toBe(true);
    },
  );

  it("rejects unrelated errors", () => {
    expect(isOutboundDispatchTerminalError(new Error("boom"))).toBe(false);
    expect(isOutboundDispatchTerminalError(undefined)).toBe(false);
    expect(isOutboundDispatchTerminalError("OutboundDispatchTerminalError")).toBe(false);
    // Same name but no reason — looks like an accidental collision, not the
    // tagged terminal error.
    const fake = new Error("x");
    fake.name = "OutboundDispatchTerminalError";
    expect(isOutboundDispatchTerminalError(fake)).toBe(false);
  });
});

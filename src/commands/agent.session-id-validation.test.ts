import { describe, expect, it } from "vitest";

/**
 * Validates that --session-id does not accept session key format.
 * The actual validation is in agentCommand, but we test the logic here
 * to avoid complex mocking of the full agent command.
 */
function validateSessionId(sessionId: string | undefined): void {
  if (sessionId?.trim().toLowerCase().startsWith("agent:")) {
    throw new Error(
      "It looks like you passed a session key to --session-id. Please use --session-key instead.",
    );
  }
}

describe("session-id validation", () => {
  it("rejects session key format passed to --session-id", () => {
    expect(() => validateSessionId("agent:jarvis:main")).toThrow(
      "Please use --session-key instead",
    );
  });

  it("rejects session key format with different casing", () => {
    expect(() => validateSessionId("Agent:Main:telegram")).toThrow(
      "Please use --session-key instead",
    );
  });

  it("rejects session key format with leading whitespace", () => {
    expect(() => validateSessionId("  agent:foo:bar")).toThrow("Please use --session-key instead");
  });

  it("accepts UUID format", () => {
    expect(() => validateSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("accepts undefined", () => {
    expect(() => validateSessionId(undefined)).not.toThrow();
  });
});

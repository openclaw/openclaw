import { describe, it, expect } from "vitest";
import { validateSpoolEvent } from "./schema.js";

describe("spool schema validation", () => {
  it("should validate a minimal valid event", () => {
    const event = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      payload: {
        kind: "agentTurn",
        message: "Hello, world!",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(true);
  });

  it("should validate an event with all optional fields", () => {
    const event = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440001",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      priority: "high",
      maxRetries: 5,
      retryCount: 2,
      expiresAt: "2026-02-04T10:30:00.000Z",
      payload: {
        kind: "agentTurn",
        message: "Test message",
        agentId: "my-agent",
        sessionKey: "custom:session",
        model: "anthropic/claude-sonnet-4-20250514",
        thinking: "low",
        delivery: {
          enabled: true,
          channel: "telegram",
          to: "123456789",
        },
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(true);
  });

  it("should reject invalid version", () => {
    const event = {
      version: 2,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      payload: {
        kind: "agentTurn",
        message: "Hello",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("version");
    }
  });

  it("should reject missing message", () => {
    const event = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      payload: {
        kind: "agentTurn",
        message: "",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(false);
  });

  it("should reject invalid UUID", () => {
    const event = {
      version: 1,
      id: "not-a-uuid",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      payload: {
        kind: "agentTurn",
        message: "Hello",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("UUID");
    }
  });

  it("should reject invalid priority", () => {
    const event = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      priority: "ultra-high",
      payload: {
        kind: "agentTurn",
        message: "Hello",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(false);
  });

  it("should reject negative maxRetries", () => {
    const event = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      maxRetries: -1,
      payload: {
        kind: "agentTurn",
        message: "Hello",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(false);
  });

  it("should reject extra unknown fields (strict mode)", () => {
    const event = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      unknownField: "should fail",
      payload: {
        kind: "agentTurn",
        message: "Hello",
      },
    };
    const result = validateSpoolEvent(event);
    expect(result.valid).toBe(false);
  });
});

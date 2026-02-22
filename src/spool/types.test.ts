import { describe, it, expect } from "vitest";
import type { SpoolEvent, SpoolPriority } from "./types.js";

describe("spool types", () => {
  it("should allow valid SpoolEvent structure", () => {
    const event: SpoolEvent = {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      createdAt: "2026-02-03T10:30:00.000Z",
      createdAtMs: 1738578600000,
      payload: {
        kind: "agentTurn",
        message: "Hello, world!",
      },
    };
    expect(event.version).toBe(1);
    expect(event.payload.kind).toBe("agentTurn");
  });

  it("should allow optional fields", () => {
    const event: SpoolEvent = {
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
    expect(event.priority).toBe("high");
    expect(event.maxRetries).toBe(5);
    expect(event.payload.delivery?.enabled).toBe(true);
  });

  it("should support all priority levels", () => {
    const priorities: SpoolPriority[] = ["low", "normal", "high", "critical"];
    for (const priority of priorities) {
      const event: SpoolEvent = {
        version: 1,
        id: "test-id",
        createdAt: new Date().toISOString(),
        createdAtMs: Date.now(),
        priority,
        payload: { kind: "agentTurn", message: "Test" },
      };
      expect(event.priority).toBe(priority);
    }
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readSpoolEvent } from "./reader.js";
import {
  buildSpoolEvent,
  createSpoolAgentTurn,
  writeSpoolEvent,
  ensureSpoolEventsDir,
} from "./writer.js";

describe("spool writer", () => {
  let tempDir: string;
  let mockEnv: Record<string, string>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spool-test-"));
    mockEnv = { HOME: tempDir };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should build a complete SpoolEvent from partial create", () => {
    const create = {
      version: 1 as const,
      payload: {
        kind: "agentTurn" as const,
        message: "Test message",
      },
    };
    const event = buildSpoolEvent(create);

    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(event.createdAt).toBeDefined();
    expect(event.createdAtMs).toBeGreaterThan(0);
    expect(event.retryCount).toBe(0);
    expect(event.payload.message).toBe("Test message");
  });

  it("should preserve optional fields when building", () => {
    const create = {
      version: 1 as const,
      priority: "high" as const,
      maxRetries: 5,
      payload: {
        kind: "agentTurn" as const,
        message: "Test",
        agentId: "test-agent",
      },
    };
    const event = buildSpoolEvent(create);

    expect(event.priority).toBe("high");
    expect(event.maxRetries).toBe(5);
    expect(event.payload.agentId).toBe("test-agent");
  });

  it("should ensure events directory exists", async () => {
    const eventsDir = await ensureSpoolEventsDir(mockEnv);
    const stat = await fs.stat(eventsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("should write and read event file", async () => {
    const event = buildSpoolEvent({
      version: 1,
      payload: {
        kind: "agentTurn",
        message: "Test message",
      },
    });

    await writeSpoolEvent(event, mockEnv);
    const result = await readSpoolEvent(event.id, mockEnv);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.event.id).toBe(event.id);
      expect(result.event.payload.message).toBe("Test message");
    }
  });

  it("should create agent turn event with helper function", async () => {
    const event = await createSpoolAgentTurn(
      "Hello, agent!",
      {
        agentId: "test-agent",
        priority: "critical",
        thinking: "high",
      },
      mockEnv,
    );

    expect(event.payload.message).toBe("Hello, agent!");
    expect(event.payload.agentId).toBe("test-agent");
    expect(event.priority).toBe("critical");
    expect(event.payload.thinking).toBe("high");

    // Verify file was written
    const result = await readSpoolEvent(event.id, mockEnv);
    expect(result.success).toBe(true);
  });

  it("should handle delivery options", async () => {
    const event = await createSpoolAgentTurn(
      "Send notification",
      {
        delivery: {
          enabled: true,
          channel: "telegram",
          to: "123456789",
        },
      },
      mockEnv,
    );

    expect(event.payload.delivery?.enabled).toBe(true);
    expect(event.payload.delivery?.channel).toBe("telegram");
    expect(event.payload.delivery?.to).toBe("123456789");
  });
});

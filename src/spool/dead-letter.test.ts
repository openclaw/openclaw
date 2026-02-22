import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  moveToDeadLetter,
  listDeadLetterIds,
  readDeadLetterEntry,
  countDeadLetterEvents,
  clearDeadLetterEvents,
} from "./dead-letter.js";
import { countSpoolEvents } from "./reader.js";
import { createSpoolAgentTurn, ensureSpoolEventsDir, buildSpoolEvent } from "./writer.js";

describe("spool dead-letter", () => {
  let tempDir: string;
  let mockEnv: Record<string, string>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spool-deadletter-test-"));
    mockEnv = { HOME: tempDir };
    await ensureSpoolEventsDir(mockEnv);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should move event to dead-letter directory", async () => {
    const event = await createSpoolAgentTurn("Test message", {}, mockEnv);
    const initialCount = await countSpoolEvents(mockEnv);
    expect(initialCount).toBe(1);

    await moveToDeadLetter(event.id, event, "max_retries", "test error", mockEnv);

    // Event should be removed from events directory
    const afterCount = await countSpoolEvents(mockEnv);
    expect(afterCount).toBe(0);

    // Event should be in dead-letter directory
    const deadLetterCount = await countDeadLetterEvents(mockEnv);
    expect(deadLetterCount).toBe(1);
  });

  it("should store dead-letter entry with metadata", async () => {
    const event = buildSpoolEvent({
      version: 1,
      payload: { kind: "agentTurn", message: "Failed event" },
    });

    await moveToDeadLetter(event.id, event, "error", "Something went wrong", mockEnv);

    const entry = await readDeadLetterEntry(event.id, mockEnv);
    expect(entry).not.toBeNull();
    expect(entry?.reason).toBe("error");
    expect(entry?.error).toBe("Something went wrong");
    expect(entry?.event?.payload.message).toBe("Failed event");
    expect(entry?.movedAt).toBeDefined();
    expect(entry?.movedAtMs).toBeGreaterThan(0);
  });

  it("should handle null event (invalid events)", async () => {
    await moveToDeadLetter("invalid-event-id", null, "invalid", "Could not parse", mockEnv);

    const entry = await readDeadLetterEntry("invalid-event-id", mockEnv);
    expect(entry).not.toBeNull();
    expect(entry?.event).toBeNull();
    expect(entry?.reason).toBe("invalid");
  });

  it("should list dead-letter IDs", async () => {
    const event1 = buildSpoolEvent({
      version: 1,
      payload: { kind: "agentTurn", message: "Event 1" },
    });
    const event2 = buildSpoolEvent({
      version: 1,
      payload: { kind: "agentTurn", message: "Event 2" },
    });

    await moveToDeadLetter(event1.id, event1, "max_retries", undefined, mockEnv);
    await moveToDeadLetter(event2.id, event2, "expired", undefined, mockEnv);

    const ids = await listDeadLetterIds(mockEnv);
    expect(ids.length).toBe(2);
    expect(ids).toContain(event1.id);
    expect(ids).toContain(event2.id);
  });

  it("should return null for non-existent dead-letter entry", async () => {
    const entry = await readDeadLetterEntry("non-existent", mockEnv);
    expect(entry).toBeNull();
  });

  it("should clear all dead-letter events", async () => {
    const event1 = buildSpoolEvent({
      version: 1,
      payload: { kind: "agentTurn", message: "Event 1" },
    });
    const event2 = buildSpoolEvent({
      version: 1,
      payload: { kind: "agentTurn", message: "Event 2" },
    });

    await moveToDeadLetter(event1.id, event1, "max_retries", undefined, mockEnv);
    await moveToDeadLetter(event2.id, event2, "error", undefined, mockEnv);

    expect(await countDeadLetterEvents(mockEnv)).toBe(2);

    const cleared = await clearDeadLetterEvents(mockEnv);
    expect(cleared).toBe(2);
    expect(await countDeadLetterEvents(mockEnv)).toBe(0);
  });

  it("should support all dead-letter reasons", async () => {
    const reasons = ["max_retries", "invalid", "expired", "error"] as const;

    for (const reason of reasons) {
      const event = buildSpoolEvent({
        version: 1,
        payload: { kind: "agentTurn", message: `Reason: ${reason}` },
      });
      await moveToDeadLetter(event.id, event, reason, undefined, mockEnv);

      const entry = await readDeadLetterEntry(event.id, mockEnv);
      expect(entry?.reason).toBe(reason);
    }
  });
});

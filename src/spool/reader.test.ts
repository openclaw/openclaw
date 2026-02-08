import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readSpoolEvent,
  readSpoolEventFile,
  listSpoolEventIds,
  listSpoolEvents,
  deleteSpoolEvent,
  countSpoolEvents,
} from "./reader.js";
import { createSpoolAgentTurn, ensureSpoolEventsDir } from "./writer.js";

describe("spool reader", () => {
  let tempDir: string;
  let mockEnv: Record<string, string>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spool-reader-test-"));
    mockEnv = { HOME: tempDir };
    await ensureSpoolEventsDir(mockEnv);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should return error for non-existent event", async () => {
    const result = await readSpoolEvent("non-existent-id", mockEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
  });

  it("should return error for invalid JSON", async () => {
    const eventsDir = path.join(tempDir, ".openclaw", "spool", "events");
    await fs.writeFile(path.join(eventsDir, "bad-json.json"), "not valid json", "utf8");

    const result = await readSpoolEventFile(path.join(eventsDir, "bad-json.json"));
    expect(result.success).toBe(false);
  });

  it("should return error for invalid event schema", async () => {
    const eventsDir = path.join(tempDir, ".openclaw", "spool", "events");
    await fs.writeFile(
      path.join(eventsDir, "invalid-event.json"),
      JSON.stringify({ version: 1, id: "not-a-uuid" }),
      "utf8",
    );

    const result = await readSpoolEventFile(path.join(eventsDir, "invalid-event.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("validation");
    }
  });

  it("should list event IDs", async () => {
    await createSpoolAgentTurn("Message 1", {}, mockEnv);
    await createSpoolAgentTurn("Message 2", {}, mockEnv);

    const ids = await listSpoolEventIds(mockEnv);
    expect(ids.length).toBe(2);
  });

  it("should not include temp files in listing", async () => {
    await createSpoolAgentTurn("Real event", {}, mockEnv);

    const eventsDir = path.join(tempDir, ".openclaw", "spool", "events");
    await fs.writeFile(path.join(eventsDir, "temp.json.tmp.123"), "temp data", "utf8");

    const ids = await listSpoolEventIds(mockEnv);
    expect(ids.length).toBe(1);
  });

  it("should list events sorted by priority and time", async () => {
    // Create events in reverse order
    await createSpoolAgentTurn("Normal 1", { priority: "normal" }, mockEnv);
    await new Promise((r) => setTimeout(r, 10));
    await createSpoolAgentTurn("High", { priority: "high" }, mockEnv);
    await new Promise((r) => setTimeout(r, 10));
    await createSpoolAgentTurn("Critical", { priority: "critical" }, mockEnv);
    await new Promise((r) => setTimeout(r, 10));
    await createSpoolAgentTurn("Normal 2", { priority: "normal" }, mockEnv);

    const events = await listSpoolEvents(mockEnv);

    // Should be sorted: critical first, then high, then normal (oldest first within same priority)
    expect(events[0].priority).toBe("critical");
    expect(events[1].priority).toBe("high");
    expect(events[2].payload.message).toBe("Normal 1");
    expect(events[3].payload.message).toBe("Normal 2");
  });

  it("should delete event", async () => {
    const event = await createSpoolAgentTurn("To be deleted", {}, mockEnv);

    let count = await countSpoolEvents(mockEnv);
    expect(count).toBe(1);

    await deleteSpoolEvent(event.id, mockEnv);

    count = await countSpoolEvents(mockEnv);
    expect(count).toBe(0);
  });

  it("should not throw when deleting non-existent event", async () => {
    await expect(deleteSpoolEvent("non-existent", mockEnv)).resolves.not.toThrow();
  });

  it("should count events", async () => {
    expect(await countSpoolEvents(mockEnv)).toBe(0);

    await createSpoolAgentTurn("Message 1", {}, mockEnv);
    expect(await countSpoolEvents(mockEnv)).toBe(1);

    await createSpoolAgentTurn("Message 2", {}, mockEnv);
    expect(await countSpoolEvents(mockEnv)).toBe(2);
  });
});

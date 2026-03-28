import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drainFileLockStateForTest } from "../plugin-sdk/file-lock.js";
import {
  QueueManager,
  serializeQueue,
  QueueLockError,
  QueueValidationError,
  QUEUE_LOCK_OPTIONS,
} from "./queue-manager.js";
import { parseQueue } from "./queue-parser.js";
import { generateQueueMd } from "./templates.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "queue-mgr-test-"));
});

afterEach(async () => {
  await drainFileLockStateForTest();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

/** Write a queue.md with some Available entries for testing. */
async function writeTestQueue(entries: string[] = ["TASK-001", "TASK-002"]): Promise<string> {
  const queuePath = path.join(tmpDir, "queue.md");
  const base = generateQueueMd();
  // Insert entries under ## Available
  const withEntries = base.replace(
    "## Available\n",
    `## Available\n\n${entries.map((id) => `- ${id}`).join("\n")}\n`,
  );
  await fs.writeFile(queuePath, withEntries, "utf8");
  return queuePath;
}

describe("serializeQueue", () => {
  it("round-trips with parseQueue (parse -> serialize -> parse = same data)", async () => {
    await writeTestQueue();
    const content = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const parsed = parseQueue(content, "queue.md");
    const serialized = serializeQueue(parsed);
    const reparsed = parseQueue(serialized, "queue.md");

    expect(reparsed.available).toEqual(parsed.available);
    expect(reparsed.claimed).toEqual(parsed.claimed);
    expect(reparsed.done).toEqual(parsed.done);
    expect(reparsed.blocked).toEqual(parsed.blocked);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
  });

  it("preserves frontmatter with updated field", async () => {
    await writeTestQueue();
    const content = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const parsed = parseQueue(content, "queue.md");
    const serialized = serializeQueue(parsed);

    expect(serialized).toMatch(/^---\n/);
    expect(serialized).toMatch(/updated:/);
    expect(serialized).toMatch(/\n---\n/);
  });

  it("preserves section headings", async () => {
    await writeTestQueue();
    const content = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const parsed = parseQueue(content, "queue.md");
    const serialized = serializeQueue(parsed);

    expect(serialized).toContain("## Available");
    expect(serialized).toContain("## Claimed");
    expect(serialized).toContain("## Done");
    expect(serialized).toContain("## Blocked");
  });

  it("formats entries with bracket metadata", () => {
    const parsed = {
      frontmatter: { updated: "2026-03-27" },
      available: [{ taskId: "TASK-001", metadata: { priority: "high", agent: "bot-a" } }],
      claimed: [],
      done: [],
      blocked: [],
    };
    const serialized = serializeQueue(parsed);

    expect(serialized).toContain("- TASK-001 [priority: high, agent: bot-a]");
  });

  it("formats entries without metadata as bare task IDs", () => {
    const parsed = {
      frontmatter: null,
      available: [{ taskId: "TASK-005", metadata: {} }],
      claimed: [],
      done: [],
      blocked: [],
    };
    const serialized = serializeQueue(parsed);

    expect(serialized).toContain("- TASK-005\n");
    expect(serialized).not.toContain("TASK-005 [");
  });
});

describe("QueueManager.claimTask", () => {
  it("moves task from available to claimed with agent metadata", async () => {
    await writeTestQueue(["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    await mgr.claimTask("TASK-001", "agent-a");

    const result = await mgr.readQueue();
    expect(result.available.find((e) => e.taskId === "TASK-001")).toBeUndefined();
    const claimed = result.claimed.find((e) => e.taskId === "TASK-001");
    expect(claimed).toBeDefined();
    expect(claimed!.metadata.agent).toBe("agent-a");
    expect(claimed!.metadata.claimed).toBeDefined();
  });

  it("throws QueueValidationError when task not in Available", async () => {
    await writeTestQueue(["TASK-002"]);
    const mgr = new QueueManager(tmpDir);

    await expect(mgr.claimTask("TASK-999", "agent-a")).rejects.toThrow(QueueValidationError);
  });

  it("validates persistence after write", async () => {
    await writeTestQueue(["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    await mgr.claimTask("TASK-001", "agent-a");

    // Read the raw file to confirm persistence
    const raw = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const reparsed = parseQueue(raw, "queue.md");
    expect(reparsed.claimed.some((e) => e.taskId === "TASK-001")).toBe(true);
    expect(reparsed.available.some((e) => e.taskId === "TASK-001")).toBe(false);
  });
});

describe("QueueManager.releaseTask", () => {
  it("moves task from claimed back to available and strips agent metadata", async () => {
    await writeTestQueue(["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    // First claim it
    await mgr.claimTask("TASK-001", "agent-a");
    // Then release it
    await mgr.releaseTask("TASK-001");

    const result = await mgr.readQueue();
    expect(result.claimed.find((e) => e.taskId === "TASK-001")).toBeUndefined();
    const available = result.available.find((e) => e.taskId === "TASK-001");
    expect(available).toBeDefined();
    expect(available!.metadata.agent).toBeUndefined();
    expect(available!.metadata.claimed).toBeUndefined();
  });

  it("throws QueueValidationError when task not in Claimed", async () => {
    await writeTestQueue(["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    await expect(mgr.releaseTask("TASK-001")).rejects.toThrow(QueueValidationError);
  });
});

describe("QueueManager.moveTask", () => {
  it("moves task from available to blocked", async () => {
    await writeTestQueue(["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    await mgr.moveTask("TASK-001", "available", "blocked");

    const result = await mgr.readQueue();
    expect(result.available.find((e) => e.taskId === "TASK-001")).toBeUndefined();
    expect(result.blocked.find((e) => e.taskId === "TASK-001")).toBeDefined();
  });

  it("throws QueueValidationError when task not in source section", async () => {
    await writeTestQueue(["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    await expect(mgr.moveTask("TASK-999", "available", "done")).rejects.toThrow(
      QueueValidationError,
    );
  });
});

describe("QueueManager.readQueue", () => {
  it("returns ParsedQueue without acquiring lock", async () => {
    await writeTestQueue(["TASK-001", "TASK-002"]);
    const mgr = new QueueManager(tmpDir);

    const result = await mgr.readQueue();

    expect(result.available).toHaveLength(2);
    expect(result.available[0].taskId).toBe("TASK-001");
    expect(result.available[1].taskId).toBe("TASK-002");
  });
});

describe("error types", () => {
  it("QueueLockError has correct name", () => {
    const err = new QueueLockError("/test/dir");
    expect(err.name).toBe("QueueLockError");
    expect(err).toBeInstanceOf(Error);
  });

  it("QueueValidationError has correct name", () => {
    const err = new QueueValidationError("test message");
    expect(err.name).toBe("QueueValidationError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("QUEUE_LOCK_OPTIONS", () => {
  it("has expected lock configuration", () => {
    expect(QUEUE_LOCK_OPTIONS.retries.retries).toBe(3);
    expect(QUEUE_LOCK_OPTIONS.retries.factor).toBe(2);
    expect(QUEUE_LOCK_OPTIONS.retries.minTimeout).toBe(50);
    expect(QUEUE_LOCK_OPTIONS.retries.maxTimeout).toBe(200);
    expect(QUEUE_LOCK_OPTIONS.retries.randomize).toBe(true);
    expect(QUEUE_LOCK_OPTIONS.stale).toBe(60_000);
  });
});

describe("concurrent access", () => {
  /** Write a queue.md with specific tasks in the Available section. */
  async function writeQueueWithTasks(dir: string, taskIds: string[]): Promise<void> {
    const entries = taskIds.map((id) => `- ${id}`).join("\n");
    const content = `---\nupdated: "2026-01-01"\n---\n\n## Available\n\n${entries}\n\n## Claimed\n\n## Done\n\n## Blocked\n`;
    await fs.writeFile(path.join(dir, "queue.md"), content, "utf8");
  }

  it("two agents claiming different tasks simultaneously both succeed", async () => {
    await writeQueueWithTasks(tmpDir, ["TASK-001", "TASK-002"]);
    const mgr1 = new QueueManager(tmpDir);
    const mgr2 = new QueueManager(tmpDir);

    const [r1, r2] = await Promise.allSettled([
      mgr1.claimTask("TASK-001", "agent-a"),
      mgr2.claimTask("TASK-002", "agent-b"),
    ]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    // Re-read and verify queue integrity
    const raw = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const parsed = parseQueue(raw, "queue.md");
    expect(parsed.available).toHaveLength(0);
    expect(parsed.claimed).toHaveLength(2);
    expect(parsed.claimed.some((e) => e.taskId === "TASK-001")).toBe(true);
    expect(parsed.claimed.some((e) => e.taskId === "TASK-002")).toBe(true);
  });

  it("two agents claiming same task: one succeeds, one gets QueueValidationError", async () => {
    await writeQueueWithTasks(tmpDir, ["TASK-001"]);
    const mgr1 = new QueueManager(tmpDir);
    const mgr2 = new QueueManager(tmpDir);

    const [r1, r2] = await Promise.allSettled([
      mgr1.claimTask("TASK-001", "agent-a"),
      mgr2.claimTask("TASK-001", "agent-b"),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejected one should be a QueueValidationError (task no longer in Available)
    const rejectedResult = rejected[0];
    expect(rejectedResult.reason).toBeInstanceOf(QueueValidationError);

    // Verify TASK-001 is in claimed exactly once
    const raw = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const parsed = parseQueue(raw, "queue.md");
    expect(parsed.claimed.filter((e) => e.taskId === "TASK-001")).toHaveLength(1);
    expect(parsed.available.filter((e) => e.taskId === "TASK-001")).toHaveLength(0);
  });

  it("lock hold time under 100ms", async () => {
    await writeQueueWithTasks(tmpDir, ["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    const start = performance.now();
    await mgr.claimTask("TASK-001", "agent-a");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it("queue.md not corrupted after 5 sequential claim-release cycles", async () => {
    await writeQueueWithTasks(tmpDir, ["TASK-001"]);
    const mgr = new QueueManager(tmpDir);

    for (let i = 0; i < 5; i++) {
      await mgr.claimTask("TASK-001", `agent-cycle-${i}`);
      await mgr.releaseTask("TASK-001");
    }

    // Final state: TASK-001 back in available, claimed empty
    const result = await mgr.readQueue();
    expect(result.available.some((e) => e.taskId === "TASK-001")).toBe(true);
    expect(result.claimed).toHaveLength(0);

    // Verify raw file parses without error (no corruption)
    const raw = await fs.readFile(path.join(tmpDir, "queue.md"), "utf8");
    const parsed = parseQueue(raw, "queue.md");
    expect(parsed.available.some((e) => e.taskId === "TASK-001")).toBe(true);
  });
});

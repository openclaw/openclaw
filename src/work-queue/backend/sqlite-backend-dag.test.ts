import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNodeSqliteAvailable } from "../../memory/sqlite.js";
import { SqliteWorkQueueBackend } from "./sqlite-backend.js";

const describeSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describeSqlite("SqliteWorkQueueBackend DAG enforcement", () => {
  function createBackend() {
    const dbPath = path.join(
      os.tmpdir(),
      `work-queue-dag-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    return { dbPath, backend: new SqliteWorkQueueBackend(dbPath) };
  }

  it("skips items with unsatisfied dependencies during claim", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "dag-test",
      agentId: "dag-test",
      name: "DAG test queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    // Create A (no deps) and B (depends on A).
    const itemA = await backend.createItem({
      queueId: queue.id,
      title: "Task A",
      status: "pending",
      priority: "medium",
    });
    const itemB = await backend.createItem({
      queueId: queue.id,
      title: "Task B",
      status: "pending",
      priority: "medium",
      dependsOn: [itemA.id],
    });

    // Claiming should return A (B has unsatisfied dep).
    const claimed = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed?.id).toBe(itemA.id);

    // B should not be claimable yet.
    const claimed2 = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed2).toBeNull();

    // Complete A.
    await backend.updateItem(itemA.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    // Now B should be claimable.
    const claimed3 = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed3?.id).toBe(itemB.id);

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("claims items with no dependencies normally", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "no-deps",
      agentId: "no-deps",
      name: "No deps queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    await backend.createItem({
      queueId: queue.id,
      title: "Independent task",
      status: "pending",
      priority: "medium",
    });

    const claimed = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed?.title).toBe("Independent task");

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("handles multi-level dependency chains (A -> B -> C)", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "chain",
      agentId: "chain",
      name: "Chain queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    const itemC = await backend.createItem({
      queueId: queue.id,
      title: "Task C (leaf)",
      status: "pending",
      priority: "medium",
    });
    const itemB = await backend.createItem({
      queueId: queue.id,
      title: "Task B (middle)",
      status: "pending",
      priority: "medium",
      dependsOn: [itemC.id],
    });
    const itemA = await backend.createItem({
      queueId: queue.id,
      title: "Task A (root)",
      status: "pending",
      priority: "medium",
      dependsOn: [itemB.id],
    });

    // Only C should be claimable.
    const first = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(first?.id).toBe(itemC.id);

    // Complete C.
    await backend.updateItem(itemC.id, { status: "completed" });

    // Now B is claimable.
    const second = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(second?.id).toBe(itemB.id);

    // Complete B.
    await backend.updateItem(itemB.id, { status: "completed" });

    // Now A is claimable.
    const third = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(third?.id).toBe(itemA.id);

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("filters by workstream during claim", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "ws-test",
      agentId: "ws-test",
      name: "Workstream test",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    await backend.createItem({
      queueId: queue.id,
      title: "Feature task",
      status: "pending",
      priority: "medium",
      workstream: "feature-dev",
    });
    await backend.createItem({
      queueId: queue.id,
      title: "Bug task",
      status: "pending",
      priority: "medium",
      workstream: "bugfix",
    });

    // Filter to bugfix workstream.
    const claimed = await backend.claimNextItem(
      queue.id,
      { agentId: "worker" },
      { workstream: "bugfix" },
    );
    expect(claimed?.title).toBe("Bug task");
    expect(claimed?.workstream).toBe("bugfix");

    // Filter to feature-dev workstream.
    const claimed2 = await backend.claimNextItem(
      queue.id,
      { agentId: "worker" },
      { workstream: "feature-dev" },
    );
    expect(claimed2?.title).toBe("Feature task");

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("skips items exceeding maxRetries during claim", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "retry-test",
      agentId: "retry-test",
      name: "Retry test queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    // Create an item with retryCount >= maxRetries.
    await backend.createItem({
      queueId: queue.id,
      title: "Exhausted task",
      status: "pending",
      priority: "medium",
      maxRetries: 2,
      retryCount: 2,
    });

    // Should not be claimable.
    const claimed = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed).toBeNull();

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("claims items with retries remaining", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "retry-ok",
      agentId: "retry-ok",
      name: "Retry OK queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    const item = await backend.createItem({
      queueId: queue.id,
      title: "Has retries",
      status: "pending",
      priority: "medium",
      maxRetries: 3,
      retryCount: 1,
    });

    const claimed = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed?.id).toBe(item.id);

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("skips items with expired deadline during claim", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "deadline-test",
      agentId: "deadline-test",
      name: "Deadline test queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    await backend.createItem({
      queueId: queue.id,
      title: "Expired task",
      status: "pending",
      priority: "medium",
      deadline: pastDeadline,
    });

    const claimed = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed).toBeNull();

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("records and lists executions", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "exec-test",
      agentId: "exec-test",
      name: "Execution test queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    const item = await backend.createItem({
      queueId: queue.id,
      title: "Test item",
      status: "pending",
      priority: "medium",
    });

    const now = new Date().toISOString();
    const exec = await backend.recordExecution({
      itemId: item.id,
      attemptNumber: 1,
      sessionKey: "session:test:1",
      outcome: "success",
      startedAt: now,
      completedAt: now,
      durationMs: 1500,
    });

    expect(exec.id).toBeDefined();
    expect(exec.itemId).toBe(item.id);
    expect(exec.outcome).toBe("success");

    const execs = await backend.listExecutions(item.id);
    expect(execs).toHaveLength(1);
    expect(execs[0]!.sessionKey).toBe("session:test:1");

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("stores and retrieves transcripts", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "transcript-test",
      agentId: "transcript-test",
      name: "Transcript test queue",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    const item = await backend.createItem({
      queueId: queue.id,
      title: "Transcript item",
      status: "pending",
      priority: "medium",
    });

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const transcriptId = await backend.storeTranscript({
      itemId: item.id,
      sessionKey: "session:test:transcript",
      transcript: messages,
    });

    expect(transcriptId).toBeDefined();

    // Retrieve it.
    const full = await backend.getTranscript(transcriptId);
    expect(full).toBeDefined();
    expect(full!.transcript).toEqual(messages);
    expect(full!.sessionKey).toBe("session:test:transcript");

    // List transcripts for item.
    const list = await backend.listTranscripts(item.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(transcriptId);

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("adds new columns via schema migration", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "migration-test",
      agentId: "migration-test",
      name: "Migration test",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    // Create item with new fields.
    const item = await backend.createItem({
      queueId: queue.id,
      title: "With new fields",
      status: "pending",
      priority: "medium",
      maxRetries: 3,
      retryCount: 1,
      deadline: "2099-01-01T00:00:00.000Z",
      lastOutcome: "error",
    });

    // Verify round-trip.
    const retrieved = await backend.getItem(item.id);
    expect(retrieved!.maxRetries).toBe(3);
    expect(retrieved!.retryCount).toBe(1);
    expect(retrieved!.deadline).toBe("2099-01-01T00:00:00.000Z");
    expect(retrieved!.lastOutcome).toBe("error");

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("claims any workstream when filter is not specified", async () => {
    const { dbPath, backend } = createBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "all-ws",
      agentId: "all-ws",
      name: "All workstreams",
      concurrencyLimit: 5,
      defaultPriority: "medium",
    });

    await backend.createItem({
      queueId: queue.id,
      title: "Has workstream",
      status: "pending",
      priority: "high",
      workstream: "alpha",
    });
    await backend.createItem({
      queueId: queue.id,
      title: "No workstream",
      status: "pending",
      priority: "medium",
    });

    // No filter — should get highest priority.
    const claimed = await backend.claimNextItem(queue.id, { agentId: "worker" });
    expect(claimed?.title).toBe("Has workstream");

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });
});

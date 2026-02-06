import { describe, expect, it } from "vitest";
import { MemoryWorkQueueBackend } from "./backend/memory-backend.js";
import { WorkQueueStore } from "./store.js";

describe("WorkQueueStore cycle detection", () => {
  it("rejects circular dependencies on createItem", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const itemA = await store.createItem({
      agentId: "test",
      title: "A",
    });
    const itemB = await store.createItem({
      agentId: "test",
      title: "B",
      dependsOn: [itemA.id],
    });

    // Try to create C that depends on B, then update A to depend on C.
    const itemC = await store.createItem({
      agentId: "test",
      title: "C",
      dependsOn: [itemB.id],
    });

    // A -> (nothing), B -> A, C -> B.
    // Try to update A to depend on C -> creates cycle A -> C -> B -> A.
    await expect(store.updateItem(itemA.id, { dependsOn: [itemC.id] })).rejects.toThrow(/cycle/i);
  });

  it("allows non-circular dependencies", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const itemA = await store.createItem({ agentId: "test", title: "A" });
    const itemB = await store.createItem({ agentId: "test", title: "B" });

    // A depends on B — no cycle.
    const updated = await store.updateItem(itemA.id, { dependsOn: [itemB.id] });
    expect(updated.dependsOn).toEqual([itemB.id]);
  });

  it("rejects self-dependency", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const item = await store.createItem({ agentId: "test", title: "Self" });

    await expect(store.updateItem(item.id, { dependsOn: [item.id] })).rejects.toThrow(/cycle/i);
  });
});

describe("WorkQueueStore DAG-aware claiming (memory backend)", () => {
  it("skips items with unsatisfied deps", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const itemA = await store.createItem({ agentId: "test", title: "A" });
    const itemB = await store.createItem({
      agentId: "test",
      title: "B",
      dependsOn: [itemA.id],
    });

    // B depends on A, so only A should be claimable.
    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed?.id).toBe(itemA.id);

    // No more claimable.
    const claimed2 = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed2).toBeNull();

    // Complete A.
    await store.updateItem(itemA.id, { status: "completed" });

    // Now B should be claimable (concurrency limit is 1, and A is completed not in_progress).
    const claimed3 = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed3?.id).toBe(itemB.id);
  });

  it("skips items that have exceeded maxRetries", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    // Create an item with maxRetries=2 and retryCount already at 2 (exhausted).
    await store.createItem({
      agentId: "test",
      title: "Exhausted retries",
      maxRetries: 2,
      retryCount: 2,
    });

    // Should not be claimable since retryCount >= maxRetries.
    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed).toBeNull();
  });

  it("claims items that have retries remaining", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const item = await store.createItem({
      agentId: "test",
      title: "Has retries left",
      maxRetries: 3,
      retryCount: 1,
    });

    // Should be claimable since retryCount(1) < maxRetries(3).
    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed?.id).toBe(item.id);
  });

  it("skips items with expired deadline", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    await store.createItem({
      agentId: "test",
      title: "Expired deadline",
      deadline: pastDeadline,
    });

    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed).toBeNull();
  });

  it("claims items with future deadline", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const futureDeadline = new Date(Date.now() + 60_000).toISOString();
    const item = await store.createItem({
      agentId: "test",
      title: "Future deadline",
      deadline: futureDeadline,
    });

    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed?.id).toBe(item.id);
  });

  it("claims items with no maxRetries set (unlimited)", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const item = await store.createItem({
      agentId: "test",
      title: "No max retries",
      retryCount: 100,
      // maxRetries not set → unlimited
    });

    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
    });
    expect(claimed?.id).toBe(item.id);
  });

  it("filters by workstream in claim", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    await store.createItem({
      agentId: "test",
      title: "Alpha task",
      workstream: "alpha",
    });
    await store.createItem({
      agentId: "test",
      title: "Beta task",
      workstream: "beta",
    });

    const claimed = await store.claimNextItem({
      agentId: "test",
      assignTo: { agentId: "test" },
      workstream: "beta",
    });
    expect(claimed?.title).toBe("Beta task");
  });
});

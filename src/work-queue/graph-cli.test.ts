import { describe, it, expect, beforeEach } from "vitest";
import { MemoryWorkQueueBackend } from "./backend/memory-backend.js";
import { WorkQueueStore } from "./store.js";

describe("work-queue graph CLI command", () => {
  let store: WorkQueueStore;
  const workstream = "test-graph-ws";

  beforeEach(async () => {
    // Use in-memory backend for testing
    const backend = new MemoryWorkQueueBackend();
    store = new WorkQueueStore(backend);

    // Clean up any existing items in the workstream
    const existingItems = await store.listItems({ workstream });
    for (const item of existingItems) {
      await store.deleteItem(item.id);
    }
  });

  it("should visualize a simple dependency graph", async () => {
    // Create test items with dependencies
    const item1 = await store.createItem({
      agentId: "test-agent",
      title: "Design API",
      description: "Design the REST API structure",
      workstream,
      priority: "high",
      status: "pending",
    });

    const item2 = await store.createItem({
      agentId: "test-agent",
      title: "Implement Auth",
      description: "Build authentication endpoints",
      workstream,
      priority: "high",
      status: "pending",
      dependsOn: [item1.id],
    });

    const item3 = await store.createItem({
      agentId: "test-agent",
      title: "Implement User CRUD",
      description: "Build user management endpoints",
      workstream,
      priority: "medium",
      status: "pending",
      dependsOn: [item1.id],
    });

    const item4 = await store.createItem({
      agentId: "test-agent",
      title: "Integration Tests",
      description: "Write end-to-end tests",
      workstream,
      priority: "low",
      status: "pending",
      dependsOn: [item2.id, item3.id],
    });

    // Fetch all items in the workstream
    const items = await store.listItems({ workstream, limit: 500 });

    expect(items.length).toBe(4);

    // Verify graph structure
    const itemMap = new Map(items.map((i) => [i.id, i]));

    // Item1 should have no dependencies
    expect(itemMap.get(item1.id)?.dependsOn ?? []).toEqual([]);

    // Item2 and Item3 should depend on Item1
    expect(itemMap.get(item2.id)?.dependsOn).toEqual([item1.id]);
    expect(itemMap.get(item3.id)?.dependsOn).toEqual([item1.id]);

    // Item4 should depend on Item2 and Item3
    expect(itemMap.get(item4.id)?.dependsOn).toContain(item2.id);
    expect(itemMap.get(item4.id)?.dependsOn).toContain(item3.id);
    expect(itemMap.get(item4.id)?.dependsOn?.length).toBe(2);

    // Find roots (items with no dependencies)
    const roots = items.filter((i) => !i.dependsOn || i.dependsOn.length === 0);
    expect(roots.length).toBe(1);
    expect(roots[0].id).toBe(item1.id);

    // Build children map
    const children = new Map<string, string[]>();
    for (const item of items) {
      for (const depId of item.dependsOn ?? []) {
        if (!children.has(depId)) children.set(depId, []);
        children.get(depId)!.push(item.id);
      }
    }

    // Verify children relationships
    expect(children.get(item1.id)?.sort()).toEqual([item2.id, item3.id].sort());
    expect(children.get(item2.id)).toContain(item4.id);
    expect(children.get(item3.id)).toContain(item4.id);
  });

  it("should handle workstreams with no items", async () => {
    const items = await store.listItems({ workstream: "nonexistent-ws", limit: 500 });
    expect(items.length).toBe(0);
  });

  it("should handle workstreams with only root items (no dependencies)", async () => {
    await store.createItem({
      agentId: "test-agent",
      title: "Task 1",
      workstream,
      status: "pending",
    });

    await store.createItem({
      agentId: "test-agent",
      title: "Task 2",
      workstream,
      status: "pending",
    });

    const items = await store.listItems({ workstream, limit: 500 });
    expect(items.length).toBe(2);

    const roots = items.filter((i) => !i.dependsOn || i.dependsOn.length === 0);
    expect(roots.length).toBe(2);
  });

  it("should produce valid JSON output structure", async () => {
    const item1 = await store.createItem({
      agentId: "test-agent",
      title: "Parent",
      workstream,
      status: "pending",
    });

    const item2 = await store.createItem({
      agentId: "test-agent",
      title: "Child",
      workstream,
      status: "pending",
      dependsOn: [item1.id],
    });

    const items = await store.listItems({ workstream, limit: 500 });

    // Simulate JSON output structure
    const graph = {
      workstream,
      nodes: items.map((i) => ({ id: i.id, title: i.title, status: i.status })),
      edges: items.flatMap((i) => (i.dependsOn ?? []).map((depId) => ({ from: i.id, to: depId }))),
    };

    expect(graph.workstream).toBe(workstream);
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]).toEqual({ from: item2.id, to: item1.id });
  });
});

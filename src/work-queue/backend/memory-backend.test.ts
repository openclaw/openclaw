import { describe, expect, it } from "vitest";
import { MemoryWorkQueueBackend } from "./memory-backend.js";

describe("MemoryWorkQueueBackend", () => {
  it("creates queues and items, then claims in priority order", async () => {
    const backend = new MemoryWorkQueueBackend();
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "main",
      agentId: "main",
      name: "Main",
      concurrencyLimit: 1,
      defaultPriority: "medium",
    });

    const low = await backend.createItem({
      queueId: queue.id,
      title: "Low",
      status: "pending",
      priority: "low",
    });
    const high = await backend.createItem({
      queueId: queue.id,
      title: "High",
      status: "pending",
      priority: "high",
      tags: ["urgent"],
    });

    const listed = await backend.listItems({ queueId: queue.id, tags: ["urgent"] });
    expect(listed.map((item) => item.id)).toEqual([high.id]);

    const claimed = await backend.claimNextItem(queue.id, { agentId: "main" });
    expect(claimed?.id).toBe(high.id);

    const denied = await backend.claimNextItem(queue.id, { agentId: "main" });
    expect(denied).toBeNull();

    const stats = await backend.getQueueStats(queue.id);
    expect(stats.pending).toBe(1);
    expect(stats.inProgress).toBe(1);

    await backend.updateItem(low.id, { status: "completed" });
    const updatedStats = await backend.getQueueStats(queue.id);
    expect(updatedStats.completed).toBe(1);

    await backend.close();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNodeSqliteAvailable } from "../../memory/sqlite.js";
import { SqliteWorkQueueBackend } from "./sqlite-backend.js";

const describeSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describeSqlite("SqliteWorkQueueBackend", () => {
  it("persists queue updates and claims work items", async () => {
    const dbPath = path.join(os.tmpdir(), `work-queue-${Date.now()}.sqlite`);
    const backend = new SqliteWorkQueueBackend(dbPath);
    await backend.initialize();

    const queue = await backend.createQueue({
      id: "agent",
      agentId: "agent",
      name: "Agent queue",
      concurrencyLimit: 2,
      defaultPriority: "medium",
    });

    const first = await backend.createItem({
      queueId: queue.id,
      title: "First",
      status: "pending",
      priority: "medium",
      createdBy: { agentId: "agent" },
    });

    await backend.updateQueue(queue.id, { concurrencyLimit: 1 });
    await backend.updateItem(first.id, { status: "blocked", statusReason: "waiting" });

    const claimed = await backend.claimNextItem(queue.id, { agentId: "agent" });
    expect(claimed).toBeNull();

    await backend.updateItem(first.id, { status: "pending" });
    const claimedAgain = await backend.claimNextItem(queue.id, { agentId: "agent" });
    expect(claimedAgain?.id).toBe(first.id);

    const items = await backend.listItems({ queueId: queue.id, assignedTo: "agent" });
    expect(items.length).toBe(1);

    await backend.close();
    fs.rmSync(dbPath, { force: true });
  });
});

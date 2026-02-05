import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNodeSqliteAvailable } from "../memory/sqlite.js";
import { MemoryWorkQueueBackend } from "./backend/memory-backend.js";
import { WorkQueueStore } from "./store.js";

describe("WorkQueueStore", () => {
  it("creates queues for agents and defaults priorities", async () => {
    const backend = new MemoryWorkQueueBackend();
    const store = new WorkQueueStore(backend);

    const item = await store.createItem({
      agentId: "main",
      title: "Investigate",
      status: "pending",
    });

    expect(item.queueId).toBe("main");
    expect(item.priority).toBe("medium");

    const queue = await store.getQueueByAgentId("main");
    expect(queue?.name).toContain("main");
  });
});

const describeSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describeSqlite("bootstrapWorkQueueForAgent", () => {
  let prevStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-work-queue-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("ensures queues exist and can auto-claim", async () => {
    const { bootstrapWorkQueueForAgent, getDefaultWorkQueueStore } = await import("./store.js");

    const store = await getDefaultWorkQueueStore();
    await store.createItem({
      agentId: "agent",
      title: "Claim me",
      status: "pending",
    });

    await bootstrapWorkQueueForAgent({
      agentId: "agent",
      sessionKey: "agent:agent:main",
      autoClaim: true,
    });

    const items = await store.listItems({ queueId: "agent" });
    expect(items[0]?.status).toBe("in_progress");
  });
});

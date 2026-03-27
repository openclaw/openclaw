import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  checkpointPath,
  createCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint.js";

describe("checkpoint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("checkpointPath replaces .md with .checkpoint.json", () => {
    expect(checkpointPath("tasks/TASK-005.md")).toBe(
      "tasks/TASK-005.checkpoint.json",
    );
  });

  it("createCheckpoint returns initial fields correctly", () => {
    const cp = createCheckpoint({
      agentId: "agent-1",
      taskId: "TASK-005",
      timestamp: "2026-03-27T12:00:00Z",
    });

    expect(cp.status).toBe("in-progress");
    expect(cp.claimed_by).toBe("agent-1");
    expect(cp.claimed_at).toBe("2026-03-27T12:00:00Z");
    expect(cp.last_step).toBe("");
    expect(cp.next_action).toBe("");
    expect(cp.progress_pct).toBe(0);
    expect(cp.files_modified).toEqual([]);
    expect(cp.failed_approaches).toEqual([]);
    expect(cp.log).toHaveLength(1);
    expect(cp.log[0]!.action).toBe("Claimed task");
    expect(cp.notes).toBe("");
  });

  it("writeCheckpoint writes JSON atomically via temp file + rename", async () => {
    const filePath = path.join(tmpDir, "TASK-005.checkpoint.json");
    const cp = createCheckpoint({
      agentId: "agent-1",
      taskId: "TASK-005",
      timestamp: "2026-03-27T12:00:00Z",
    });

    await writeCheckpoint(filePath, cp);

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe("in-progress");
    expect(parsed.claimed_by).toBe("agent-1");
  });

  it("readCheckpoint returns parsed CheckpointData from existing file", async () => {
    const filePath = path.join(tmpDir, "TASK-005.checkpoint.json");
    const cp = createCheckpoint({
      agentId: "agent-1",
      taskId: "TASK-005",
      timestamp: "2026-03-27T12:00:00Z",
    });

    await fs.writeFile(filePath, JSON.stringify(cp), "utf-8");

    const result = await readCheckpoint(filePath);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("in-progress");
    expect(result!.claimed_by).toBe("agent-1");
  });

  it("readCheckpoint returns null when file does not exist", async () => {
    const filePath = path.join(tmpDir, "nonexistent.checkpoint.json");
    const result = await readCheckpoint(filePath);
    expect(result).toBeNull();
  });

  it("readCheckpoint returns null when file contains invalid JSON", async () => {
    const filePath = path.join(tmpDir, "corrupted.checkpoint.json");
    await fs.writeFile(filePath, "{{not valid json!!", "utf-8");

    const result = await readCheckpoint(filePath);
    expect(result).toBeNull();
  });

  it("createCheckpoint includes initial log entry with Claimed task action", () => {
    const cp = createCheckpoint({
      agentId: "agent-1",
      taskId: "TASK-005",
      timestamp: "2026-03-27T12:00:00Z",
    });

    expect(cp.log).toHaveLength(1);
    expect(cp.log[0]).toEqual({
      timestamp: "2026-03-27T12:00:00Z",
      agent: "agent-1",
      action: "Claimed task",
    });
  });

  it("writeCheckpoint round-trips with readCheckpoint", async () => {
    const filePath = path.join(tmpDir, "TASK-005.checkpoint.json");
    const cp = createCheckpoint({
      agentId: "agent-2",
      taskId: "TASK-005",
      timestamp: "2026-03-27T14:00:00Z",
    });
    cp.progress_pct = 50;
    cp.last_step = "Implemented feature X";
    cp.next_action = "Write tests";
    cp.files_modified = ["src/foo.ts"];
    cp.failed_approaches = [
      { approach: "Used library Y", reason: "Too slow" },
    ];
    cp.notes = "Some notes";

    await writeCheckpoint(filePath, cp);
    const result = await readCheckpoint(filePath);

    expect(result).toEqual(cp);
  });
});

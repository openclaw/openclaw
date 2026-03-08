import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory index per-file error resilience", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;
  const embedBatch = getEmbedBatchMock();

  beforeEach(async () => {
    resetEmbeddingMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-resilience-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("indexes healthy files even when one file triggers an embedding error", async () => {
    // Create two memory files: one "good" and one that will fail
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Good file content that works fine");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "notes.md"),
      "Another good file with notes",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "huge.md"),
      "This file will trigger an embedding error",
    );

    // Make embedBatch fail only for the "huge" file's content
    let callCount = 0;
    embedBatch.mockImplementation(async (texts: string[]) => {
      callCount += 1;
      for (const text of texts) {
        if (text.includes("trigger an embedding error")) {
          throw new Error(
            'openai embeddings failed: 400 {"error":{"message":"the input length exceeds the context length"}}',
          );
        }
      }
      return texts.map(() => [0, 1, 0]);
    });

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Sync should NOT throw even though one file fails
    await expect(manager.sync({ force: true })).resolves.toBeUndefined();

    // Verify that embedBatch was called (proving we actually attempted indexing)
    expect(callCount).toBeGreaterThan(0);

    // Search should return results from the successfully indexed files
    const results = await manager.search("good file", { maxResults: 10, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("session files: indexes healthy files even when one fails", async () => {
    // Create session files in the agent's sessions directory
    const sessionsDir = path.join(workspaceDir, ".openclaw", "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "good-session.jsonl"),
      JSON.stringify({ message: { role: "user", content: "session content that works" } }) + "\n",
    );
    await fs.writeFile(
      path.join(sessionsDir, "bad-session.jsonl"),
      JSON.stringify({
        message: { role: "user", content: "session with broken embedding content" },
      }) + "\n",
    );
    // Also need a memory file so sync doesn't skip entirely
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Base memory content");

    embedBatch.mockImplementation(async (texts: string[]) => {
      for (const text of texts) {
        if (text.includes("broken embedding")) {
          throw new Error("openai embeddings failed: 400 context length exceeded");
        }
      }
      return texts.map(() => [0, 1, 0]);
    });

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sessions: { enabled: true },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Should NOT throw even though one session file fails
    await expect(manager.sync({ force: true })).resolves.toBeUndefined();
  });

  it("reports correct progress even when some files fail", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Healthy content");
    await fs.writeFile(path.join(workspaceDir, "memory", "broken.md"), "broken embedding content");

    embedBatch.mockImplementation(async (texts: string[]) => {
      for (const text of texts) {
        if (text.includes("broken embedding")) {
          throw new Error("openai embeddings failed: 400 context length exceeded");
        }
      }
      return texts.map(() => [0, 1, 0]);
    });

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    const progressUpdates: Array<{ completed: number; total: number }> = [];
    await manager.sync({
      force: true,
      progress: (update) =>
        progressUpdates.push({ completed: update.completed, total: update.total }),
    });

    // Progress should still complete (all files processed, even if some errored)
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last).toBeDefined();
    expect(last.completed).toBe(last.total);
  });
});

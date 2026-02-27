import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory manager readonly recovery", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-readonly-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("reopens sqlite and retries once when sync hits SQLITE_READONLY", async () => {
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

    const runSyncSpy = vi.spyOn(
      manager as unknown as {
        runSync: (params?: { reason?: string; force?: boolean }) => Promise<void>;
      },
      "runSync",
    );
    runSyncSpy
      .mockRejectedValueOnce(new Error("attempt to write a readonly database"))
      .mockResolvedValueOnce(undefined);
    const openDatabaseSpy = vi.spyOn(
      manager as unknown as { openDatabase: () => DatabaseSync },
      "openDatabase",
    );

    await manager.sync({ reason: "test" });

    expect(runSyncSpy).toHaveBeenCalledTimes(2);
    expect(openDatabaseSpy).toHaveBeenCalledTimes(1);
    expect(manager.status().custom?.readonlyRecovery).toEqual({
      attempts: 1,
      successes: 1,
      failures: 0,
      lastError: "attempt to write a readonly database",
    });
  });

  it("reopens sqlite and retries when readonly appears in error code", async () => {
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

    const runSyncSpy = vi.spyOn(
      manager as unknown as {
        runSync: (params?: { reason?: string; force?: boolean }) => Promise<void>;
      },
      "runSync",
    );
    runSyncSpy
      .mockRejectedValueOnce({ message: "write failed", code: "SQLITE_READONLY" })
      .mockResolvedValueOnce(undefined);
    const openDatabaseSpy = vi.spyOn(
      manager as unknown as { openDatabase: () => DatabaseSync },
      "openDatabase",
    );

    await manager.sync({ reason: "test" });

    expect(runSyncSpy).toHaveBeenCalledTimes(2);
    expect(openDatabaseSpy).toHaveBeenCalledTimes(1);
    expect(manager.status().custom?.readonlyRecovery).toEqual({
      attempts: 1,
      successes: 1,
      failures: 0,
      lastError: "write failed",
    });
  });

  it("does not retry non-readonly sync errors", async () => {
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

    const runSyncSpy = vi.spyOn(
      manager as unknown as {
        runSync: (params?: { reason?: string; force?: boolean }) => Promise<void>;
      },
      "runSync",
    );
    runSyncSpy.mockRejectedValueOnce(new Error("embedding timeout"));
    const openDatabaseSpy = vi.spyOn(
      manager as unknown as { openDatabase: () => DatabaseSync },
      "openDatabase",
    );

    await expect(manager.sync({ reason: "test" })).rejects.toThrow("embedding timeout");
    expect(runSyncSpy).toHaveBeenCalledTimes(1);
    expect(openDatabaseSpy).toHaveBeenCalledTimes(0);
  });
});

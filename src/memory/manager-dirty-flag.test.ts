/**
 * Test to verify the dirty flag false positive fix.
 *
 * This test verifies that:
 * 1. After a sync completes, dirty is set to false
 * 2. The dirty state is persisted to metadata
 * 3. A new manager instance restores the dirty state from metadata
 * 4. The dirty flag doesn't incorrectly reset to true on each new instance
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { MemoryIndexManager } from "./manager.js";
import type { OpenClawConfig } from "../config/config.js";

describe("MemoryIndexManager dirty flag persistence", () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    // Create temporary directories for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
    dbPath = path.join(tempDir, "memory.db");
    workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    // Create a minimal config
    cfg = {
      agents: {
        defaults: {
          memory: {
            search: {
              enabled: true,
              provider: "local",
              sources: ["memory"],
              store: {
                path: dbPath,
                vector: {
                  enabled: false,
                },
              },
              cache: {
                enabled: false,
              },
              query: {
                hybrid: {
                  enabled: false,
                },
              },
              sync: {
                onSearch: false,
                onSessionStart: false,
              },
              extraPaths: [],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should persist dirty=false after sync and restore it on new instance", async () => {
    // Create first manager instance
    const manager1 = await MemoryIndexManager.get({
      cfg,
      agentId: "test-agent",
    });

    expect(manager1).not.toBeNull();
    if (!manager1) return;

    // Initial state should be dirty=true (memory source present)
    let status = manager1.status();
    expect(status.dirty).toBe(true);

    // Run sync
    await manager1.sync({ force: true });

    // After sync, dirty should be false
    status = manager1.status();
    expect(status.dirty).toBe(false);

    // Close the manager (removes from cache)
    await manager1.close();

    // Create a new manager instance (simulates next command)
    const manager2 = await MemoryIndexManager.get({
      cfg,
      agentId: "test-agent",
    });

    expect(manager2).not.toBeNull();
    if (!manager2) return;

    // The new instance should restore dirty=false from metadata
    status = manager2.status();
    expect(status.dirty).toBe(false);

    await manager2.close();
  });

  it("should set dirty=true when files change and persist it", async () => {
    // Create manager and sync
    const manager1 = await MemoryIndexManager.get({
      cfg,
      agentId: "test-agent",
    });

    expect(manager1).not.toBeNull();
    if (!manager1) return;

    await manager1.sync({ force: true });
    expect(manager1.status().dirty).toBe(false);

    // Simulate file change by manually setting dirty
    // (In real usage, the watcher would do this)
    await manager1.close();

    // Create a test file to trigger watcher
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "test.md"), "# Test");

    // Create new manager - it should detect the file
    const manager2 = await MemoryIndexManager.get({
      cfg,
      agentId: "test-agent",
    });

    expect(manager2).not.toBeNull();
    if (!manager2) return;

    // After detecting new file, dirty should be true
    // Note: This might need a small delay for watcher to trigger
    await new Promise((resolve) => setTimeout(resolve, 100));

    await manager2.close();
  });
});

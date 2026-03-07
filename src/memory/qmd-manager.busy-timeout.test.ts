import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dbExecMock, databaseCtorMock } = vi.hoisted(() => {
  const exec = vi.fn();
  const close = vi.fn();
  const ctor = vi.fn().mockImplementation(function DatabaseSync(this: { exec: Mock; close: Mock }) {
    this.exec = exec;
    this.close = close;
  });
  return { dbExecMock: exec, databaseCtorMock: ctor };
});

vi.mock("./sqlite.js", () => ({
  requireNodeSqlite: () => ({
    DatabaseSync: databaseCtorMock,
  }),
}));

import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { QmdMemoryManager } from "./qmd-manager.js";

describe("QmdMemoryManager busy timeout", () => {
  afterEach(() => {
    dbExecMock.mockClear();
    databaseCtorMock.mockClear();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("sets sqlite busy_timeout high enough to tolerate concurrent updates", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-busy-timeout-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const stateDir = path.join(tmpRoot, "state");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    let manager: QmdMemoryManager | null = null;
    try {
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          },
        },
      };

      const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
      manager = await QmdMemoryManager.create({
        cfg,
        agentId: "main",
        resolved,
        mode: "status",
      });
      expect(manager).toBeTruthy();
      if (!manager) {
        throw new Error("manager should be created");
      }

      (manager as unknown as { ensureDb: () => unknown }).ensureDb();
      expect(dbExecMock).toHaveBeenCalledWith("PRAGMA busy_timeout = 5000");
    } finally {
      await manager?.close();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

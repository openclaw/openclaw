import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { createHookEvent } from "../../hooks.js";

const listAgentIds = vi.fn();
const resolveAgentWorkspaceDir = vi.fn();
const logDebug = vi.fn();
const logInfo = vi.fn();

vi.mock("../../../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveAgentWorkspaceDir,
}));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: logDebug,
    info: logInfo,
  }),
}));

const { default: dailyMemoryHook } = await import("./handler.js");

const tempDirs = new Set<string>();

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-memory-hook-"));
  tempDirs.add(dir);
  return dir;
}

function makeConfig(): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "daily-memory": {
            enabled: true,
          },
        },
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("daily-memory hook", () => {
  it("ignores unrelated events", async () => {
    const workspaceDir = await makeTempWorkspace();
    await dailyMemoryHook(
      createHookEvent("command", "new", "agent:main:main", {
        cfg: makeConfig(),
        workspaceDir,
      }),
    );

    await expect(fs.access(path.join(workspaceDir, "memory"))).rejects.toThrow();
  });

  it("creates today's and future daily logs during agent bootstrap", async () => {
    const workspaceDir = await makeTempWorkspace();
    const cfg: OpenClawConfig = {
      hooks: {
        internal: {
          entries: {
            "daily-memory": {
              enabled: true,
              createDaysAhead: 1,
            },
          },
        },
      },
    };

    await dailyMemoryHook(
      createHookEvent("agent", "bootstrap", "agent:main:main", {
        cfg,
        agentId: "main",
        workspaceDir,
        bootstrapFiles: [],
      }),
    );

    const files = await fs.readdir(path.join(workspaceDir, "memory"));
    expect(files).toHaveLength(2);
  });

  it("does nothing when the hook is disabled", async () => {
    const workspaceDir = await makeTempWorkspace();
    await dailyMemoryHook(
      createHookEvent("agent", "bootstrap", "agent:main:main", {
        cfg: {
          hooks: {
            internal: {
              entries: {
                "daily-memory": {
                  enabled: false,
                },
              },
            },
          },
        },
        agentId: "main",
        workspaceDir,
        bootstrapFiles: [],
      }),
    );

    await expect(fs.access(path.join(workspaceDir, "memory"))).rejects.toThrow();
  });

  it("respects a custom template", async () => {
    const workspaceDir = await makeTempWorkspace();
    await dailyMemoryHook(
      createHookEvent("agent", "bootstrap", "agent:main:main", {
        cfg: {
          hooks: {
            internal: {
              entries: {
                "daily-memory": {
                  enabled: true,
                  template: "# Custom {{date}}\n",
                  createDaysAhead: 0,
                },
              },
            },
          },
        },
        agentId: "main",
        workspaceDir,
        bootstrapFiles: [],
      }),
    );

    const files = await fs.readdir(path.join(workspaceDir, "memory"));
    const content = await fs.readFile(path.join(workspaceDir, "memory", files[0]), "utf-8");
    expect(content).toContain("# Custom ");
  });

  it("does not overwrite existing daily logs", async () => {
    const workspaceDir = await makeTempWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const existingPath = path.join(memoryDir, `${new Date().toISOString().slice(0, 10)}.md`);
    await fs.writeFile(existingPath, "# keep me\n", "utf-8");

    await dailyMemoryHook(
      createHookEvent("agent", "bootstrap", "agent:main:main", {
        cfg: makeConfig(),
        agentId: "main",
        workspaceDir,
        bootstrapFiles: [],
      }),
    );

    await expect(fs.readFile(existingPath, "utf-8")).resolves.toBe("# keep me\n");
  });

  it("creates daily logs for each configured agent on gateway startup", async () => {
    const mainWorkspaceDir = await makeTempWorkspace();
    const opsWorkspaceDir = await makeTempWorkspace();
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "ops" }] },
      hooks: {
        internal: {
          entries: {
            "daily-memory": {
              enabled: true,
              createDaysAhead: 0,
            },
          },
        },
      },
    };

    listAgentIds.mockReturnValue(["main", "ops"]);
    resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "main" ? mainWorkspaceDir : opsWorkspaceDir,
    );

    await dailyMemoryHook(createHookEvent("gateway", "startup", "gateway:startup", { cfg }));

    await expect(fs.readdir(path.join(mainWorkspaceDir, "memory"))).resolves.toHaveLength(1);
    await expect(fs.readdir(path.join(opsWorkspaceDir, "memory"))).resolves.toHaveLength(1);
  });
});

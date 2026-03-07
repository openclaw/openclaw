import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  agentUiCommand,
  ensureAgentUiMemoryBridge,
  resolveAgentUiLaunchSpec,
  resolveAgentUiMemoryBridgePaths,
} from "./agent-ui.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("resolveAgentUiLaunchSpec", () => {
  it("prefers explicit command", () => {
    const result = resolveAgentUiLaunchSpec({
      command: "codex",
      args: ["--profile", "work"],
      provider: "codex-cli",
      config: {} as OpenClawConfig,
    });

    expect(result).toEqual({
      command: "codex",
      args: ["--profile", "work"],
      provider: "codex-cli",
    });
  });

  it("resolves command from configured provider", () => {
    const result = resolveAgentUiLaunchSpec({
      provider: "my-cli",
      args: ["--foo"],
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "my-cli": {
                command: "myagent",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toEqual({
      command: "myagent",
      args: ["--foo"],
      provider: "my-cli",
    });
  });

  it("fails without command/provider", () => {
    expect(() =>
      resolveAgentUiLaunchSpec({
        config: {} as OpenClawConfig,
      }),
    ).toThrow("Provide --command <binary> or --provider <id>");
  });
});

describe("ensureAgentUiMemoryBridge", () => {
  it("resolves bridge paths without creating files", async () => {
    const targetDir = await makeTempDir("openclaw-agent-ui-target-");
    const workspaceDir = await makeTempDir("openclaw-agent-ui-workspace-");

    const paths = resolveAgentUiMemoryBridgePaths({ targetDir, workspaceDir });

    expect(paths.targetAgentsPath).toBe(path.join(targetDir, "AGENTS.md"));
    expect(paths.workspaceAgentsPath).toBe(path.join(workspaceDir, "AGENTS.md"));
    expect(paths.memoryDir).toBe(path.join(workspaceDir, "memory"));
    expect(paths.memoryFile).toBe(path.join(workspaceDir, "MEMORY.md"));
  });

  it("creates AGENTS bridge and MEMORY.md if missing", async () => {
    const targetDir = await makeTempDir("openclaw-agent-ui-target-");
    const workspaceDir = await makeTempDir("openclaw-agent-ui-workspace-");

    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# Workspace AGENTS\n", "utf-8");

    const result = await ensureAgentUiMemoryBridge({
      targetDir,
      workspaceDir,
    });

    const targetAgents = await fs.readFile(path.join(targetDir, "AGENTS.md"), "utf-8");
    const memoryFile = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");

    expect(targetAgents).toContain("OPENCLAW_MEMORY_BRIDGE:START");
    expect(targetAgents).toContain(result.workspaceAgentsPath);
    expect(targetAgents).toContain(result.memoryDir);
    expect(targetAgents).toContain(result.memoryFile);
    expect(memoryFile).toContain("# MEMORY.md");
  });

  it("replaces existing bridge block instead of duplicating", async () => {
    const targetDir = await makeTempDir("openclaw-agent-ui-target-");
    const workspaceDirA = await makeTempDir("openclaw-agent-ui-workspace-a-");
    const workspaceDirB = await makeTempDir("openclaw-agent-ui-workspace-b-");

    await fs.writeFile(path.join(workspaceDirA, "AGENTS.md"), "# A\n", "utf-8");
    await fs.writeFile(path.join(workspaceDirB, "AGENTS.md"), "# B\n", "utf-8");

    await ensureAgentUiMemoryBridge({ targetDir, workspaceDir: workspaceDirA });
    await ensureAgentUiMemoryBridge({ targetDir, workspaceDir: workspaceDirB });

    const content = await fs.readFile(path.join(targetDir, "AGENTS.md"), "utf-8");
    const occurrences = content.match(/OPENCLAW_MEMORY_BRIDGE:START/g) ?? [];

    expect(occurrences).toHaveLength(1);
    expect(content).toContain(path.join(workspaceDirB, "MEMORY.md"));
    expect(content).not.toContain(path.join(workspaceDirA, "MEMORY.md"));
  });
});

describe("agentUiCommand", () => {
  it("does not write workspace or bridge files in dry-run mode", async () => {
    const rootDir = await makeTempDir("openclaw-agent-ui-dry-run-");
    const stateDir = path.join(rootDir, "state");
    const targetDir = path.join(rootDir, "target");
    const workspaceDir = path.join(rootDir, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
      "utf-8",
    );

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        clearConfigCache();
        const runtime = { log: vi.fn(), error: vi.fn() };
        const result = await agentUiCommand(
          {
            command: "codex",
            cwd: targetDir,
            dryRun: true,
            json: true,
          },
          runtime as never,
        );

        expect(result.bridge?.targetAgentsPath).toBe(path.join(targetDir, "AGENTS.md"));
        expect(result.bridge?.memoryFile).toBe(path.join(workspaceDir, "MEMORY.md"));
        expect(await pathExists(targetDir)).toBe(false);
        expect(await pathExists(path.join(targetDir, "AGENTS.md"))).toBe(false);
        expect(await pathExists(workspaceDir)).toBe(false);
        expect(await pathExists(path.join(workspaceDir, "memory"))).toBe(false);
        expect(await pathExists(path.join(workspaceDir, "MEMORY.md"))).toBe(false);
      },
    );

    clearConfigCache();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ensureAgentUiMemoryBridge, resolveAgentUiLaunchSpec } from "./agent-ui.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";

async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
}

async function makeRepoRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
}

function buildParams(params: { config?: OpenClawConfig; workspaceDir?: string; cwd?: string }) {
  return buildSystemPromptParams({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    runtime: {
      host: "host",
      os: "os",
      arch: "arch",
      node: "node",
      model: "model",
    },
  });
}

describe("buildSystemPromptParams repo root", () => {
  it("detects repo root from workspaceDir", async () => {
    const temp = await makeTempDir("workspace");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(repoRoot, "nested", "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("falls back to cwd when workspaceDir has no repo", async () => {
    const temp = await makeTempDir("cwd");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(temp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildParams({ workspaceDir, cwd: repoRoot });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("uses configured repoRoot when valid", async () => {
    const temp = await makeTempDir("config");
    const repoRoot = path.join(temp, "config-root");
    const workspaceDir = path.join(temp, "workspace");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(workspaceDir);

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          repoRoot,
        },
      },
    };

    const { runtimeInfo } = buildParams({ config, workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("ignores invalid repoRoot config and auto-detects", async () => {
    const temp = await makeTempDir("invalid");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(repoRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          repoRoot: path.join(temp, "missing"),
        },
      },
    };

    const { runtimeInfo } = buildParams({ config, workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("returns undefined when no repo is found", async () => {
    const workspaceDir = await makeTempDir("norepo");

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.repoRoot).toBeUndefined();
  });

  it("includes the default profile canvas root in runtimeInfo", async () => {
    const workspaceDir = await makeTempDir("canvas-root");

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.canvasRootDir).toBe(path.resolve(path.join(resolveStateDir(), "canvas")));
  });

  it("includes Discord activity runtime details only when activity mode is enabled", async () => {
    const workspaceDir = await makeTempDir("discord-activity-runtime");

    const disabled = buildParams({
      workspaceDir,
      config: {
        canvasHost: {
          activity: {
            enabled: false,
            token: "secret",
          },
        },
      },
    }).runtimeInfo;
    expect(disabled.discordActivityEnabled).toBe(false);
    expect(disabled.discordActivityPath).toBeUndefined();
    expect(disabled.discordActivityTokenRequired).toBe(false);

    const enabled = buildParams({
      workspaceDir,
      config: {
        canvasHost: {
          activity: {
            enabled: true,
            token: "secret",
          },
        },
      },
    }).runtimeInfo;
    expect(enabled.discordActivityEnabled).toBe(true);
    expect(enabled.discordActivityPath).toBe("/__openclaw__/canvas/");
    expect(enabled.discordActivityTokenRequired).toBe(true);
    expect(enabled.discordActivityRequireLaunchContext).toBe(true);

    const explicitOff = buildParams({
      workspaceDir,
      config: {
        canvasHost: {
          activity: {
            enabled: true,
            requireLaunchContext: false,
          },
        },
      },
    }).runtimeInfo;
    expect(explicitOff.discordActivityRequireLaunchContext).toBe(false);
  });
});

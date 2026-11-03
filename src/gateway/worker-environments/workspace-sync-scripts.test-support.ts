import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runCommandWithTimeout, type CommandOptions } from "../../process/exec.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

export async function writeWorkspaceFiles(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([name, value]) => {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, value);
    }),
  );
}

export async function expectWorkspaceFiles(root: string, files: Record<string, string | null>) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    if (content === null) {
      await expect(fs.access(target)).rejects.toThrow();
    } else {
      await expect(fs.readFile(target, "utf8")).resolves.toBe(content);
    }
  }
}

export function workspaceScriptRunner(script: string, workspace: string, baseEnv = process.env) {
  return (args: string[] = [], options: CommandOptions = {}) =>
    runCommandWithTimeout([process.execPath, "-e", script, workspace, ...args], {
      timeoutMs: 10_000,
      baseEnv,
      ...options,
    });
}

export async function createScriptWorkspace(root: string) {
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
  const env = { ...process.env, HOME: home };
  const manifestRoot = path.join(home, ".openclaw-worker", "manifests");
  const readManifest = async (ref: string): Promise<WorkerWorkspaceManifest> =>
    JSON.parse(await fs.readFile(path.join(manifestRoot, ref.slice(7) + ".json"), "utf8"));
  return {
    root,
    home,
    workspace,
    env,
    manifestRoot,
    readManifest,
    runManifest: workspaceScriptRunner(REMOTE_WORKSPACE_MANIFEST_JS, workspace, env),
    runScript: (script: string) => workspaceScriptRunner(script, workspace, env),
  };
}

export async function initializeScriptGitWorkspace(workspace: string, stagedPath: string) {
  for (const args of [
    ["init", "--quiet"],
    ["add", stagedPath],
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@openclaw.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ],
  ]) {
    const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
  }
  const head = await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
    timeoutMs: 10_000,
  });
  expect(head.code).toBe(0);
  return head.stdout.trim();
}

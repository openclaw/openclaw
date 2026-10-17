import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect } from "vitest";
import type { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
export const readText = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");

export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

export async function initializeRepository(
  root: string,
  prepare?: (repo: string) => Promise<void>,
) {
  const repo = path.join(root, "source");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await prepare?.(repo);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initialize managed worktree fixture");
  return { repo: await fs.realpath(repo), baseCommit: await git(repo, "rev-parse", "HEAD") };
}

export function useWorktreeGateway(workboard = false) {
  let owner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
  afterEach(async () => {
    if (owner) {
      await stopQaGatewayFixture(owner);
    }
    owner = undefined;
  });
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  return {
    tempDir: async (prefix: string) => tempDirs.make(prefix, await fs.realpath(os.tmpdir())),
    async start() {
      const { createQaLiveLaneGateway } =
        await import("../../../../extensions/qa-lab/runtime-api.js");
      owner = createQaLiveLaneGateway();
      const harness = await owner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna",
        transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (config: OpenClawConfig) => {
          if (workboard) {
            const plugins = (config.plugins ??= {});
            plugins.allow = [...new Set([...(plugins.allow ?? []), "workboard"])];
            plugins.entries = { ...plugins.entries, workboard: { enabled: true } };
          }
          return config;
        },
      });
      const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) =>
        harness.gateway.call(
          method,
          params,
          timeoutMs === undefined ? undefined : { timeoutMs },
        ) as Promise<T>;
      return {
        gateway: harness.gateway,
        call,
        async waitForRun(runId: unknown) {
          expect(await call("agent.wait", { runId, timeoutMs: 30_000 }, 35_000)).toMatchObject({
            status: "ok",
          });
        },
      };
    },
  };
}

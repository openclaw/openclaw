import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { useManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const initializeRepository = useManagedWorktreeTestRepository();
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

it("refuses an ambient state/config switch during offline admission before creating a worktree", async () => {
  const root = roots.make("openclaw-routing-selector-");
  const repoRoot = await initializeRepository(root);
  const configs = [];
  for (const name of ["selected", "replacement"]) {
    const stateDir = path.join(root, name);
    const configPath = path.join(stateDir, "openclaw.json");
    const worktreeRoot = path.join(root, `${name}-worktrees`);
    await fs.mkdir(stateDir);
    await fs.writeFile(configPath, JSON.stringify({ worktreeRoot, worktreeAcceleration: false }));
    configs.push({ stateDir, configPath, worktreeRoot });
  }
  resetConfigRuntimeState();
  vi.stubEnv("OPENCLAW_STATE_DIR", configs[0]!.stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configs[0]!.configPath);
  const admissions: { stateDir: string | undefined; worktreeRoot: string | undefined }[] = [];
  const operation = runWithLocalStateOwner({
    method: "worktrees.create",
    params: { repoRoot, name: "redirected" },
    target: repoRoot,
    runLocal: ({ env, config, signal, assertCurrent }) => {
      admissions.push({ stateDir: env.OPENCLAW_STATE_DIR, worktreeRoot: config.worktreeRoot });
      return new ManagedWorktreeService({ env, getConfig: () => config }).create({
        repoRoot,
        name: "redirected",
        baseRef: "HEAD",
        signal,
        commitGuard: assertCurrent,
      });
    },
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", configs[1]!.stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configs[1]!.configPath);
  const outcome = await operation.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  expect(admissions).toEqual([]);
  expect(outcome).toMatchObject({ ok: false, error: { code: "OWNER_UNAVAILABLE" } });
  expect(
    (await execFileAsync("git", ["-C", repoRoot, "branch", "--list", "openclaw/redirected"]))
      .stdout,
  ).toBe("");
  for (const config of configs) {
    await expect(fs.access(config.worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

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

it.each(["missing", "zero-byte"])(
  "preserves a %s database when the local operation refuses before needing config",
  async (kind) => {
    const root = roots.make("openclaw-routing-refusal-");
    const configPath = path.join(root, "openclaw.json");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath));
    await fs.writeFile(configPath, "{}");
    if (kind === "zero-byte") {
      await fs.writeFile(databasePath, "");
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const refusal = new Error("Outcome refused before writing");
    await expect(
      runWithLocalStateOwner({
        method: "backup.recordOutcome",
        params: {},
        target: "backup outcome ledger",
        runLocal: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    if (kind === "missing") {
      await expect(fs.readFile(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readFile(databasePath)).toEqual(Buffer.alloc(0));
    }
  },
);

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

it("refuses an explicit nested target override before admitting the second root", async () => {
  const root = roots.make("openclaw-routing-nested-");
  const selected = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(root, "selected"),
    OPENCLAW_CONFIG_PATH: path.join(root, "selected", "openclaw.json"),
  };
  const replacement = {
    ...selected,
    OPENCLAW_STATE_DIR: path.join(root, "replacement"),
    OPENCLAW_CONFIG_PATH: path.join(root, "replacement", "openclaw.json"),
  };
  const nestedMutation = vi.fn(async () => {});
  await expect(
    runWithLocalStateOwner({
      env: selected,
      method: "fixture.outer",
      params: {},
      target: "selected root",
      runLocal: async () => {
        await Promise.resolve();
        return await runWithLocalStateOwner({
          env: replacement,
          method: "fixture.nested",
          params: {},
          target: "replacement root",
          runLocal: nestedMutation,
        });
      },
    }),
  ).rejects.toThrow("Nested operation changed the selected state root or config path");
  expect(nestedMutation).not.toHaveBeenCalled();
  await expect(fs.access(replacement.OPENCLAW_STATE_DIR)).rejects.toMatchObject({ code: "ENOENT" });
});

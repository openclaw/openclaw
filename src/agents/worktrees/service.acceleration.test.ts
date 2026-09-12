import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandExec from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import {
  detectWorktreeFilesystemBackend,
  type WorktreeFilesystemBackend,
} from "./filesystem-backend.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates } from "./template-registry.js";

vi.mock("./filesystem-backend.js", () => ({
  detectWorktreeFilesystemBackend: vi.fn(),
}));

const execFileAsync = promisify(execFile);
const realRunCommand = commandExec.runCommandWithTimeout;
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("ManagedWorktreeService filesystem acceleration", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let acceleration: boolean | undefined;
  let service: ManagedWorktreeService;
  let backend: WorktreeFilesystemBackend;

  beforeEach(async () => {
    // Hosted runners can install system-wide LFS filters, which intentionally
    // disable acceleration. Each case owns its checkout policy instead.
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-worktree-acceleration-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = Date.now();
    acceleration = undefined;
    // Real Git and the production lifecycle run on every host; only native
    // subvolume operations are replaced with independent directory copies.
    backend = {
      id: "btrfs",
      createTemplate: vi.fn(async (destination, options) => {
        options.commitGuard();
        await fs.mkdir(destination);
      }),
      cloneTemplate: vi.fn(async (source, destination, options) => {
        options.commitGuard();
        await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
      }),
    };
    vi.mocked(detectWorktreeFilesystemBackend).mockReset().mockResolvedValue(backend);
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: acceleration }),
    });
  });

  it("reuses clean source while including current ignored files and running setup for each checkout", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nprivate.txt\nsetup-ran.txt\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure provisioning");
    await fs.writeFile(path.join(repo, "README.md"), "uncommitted source edit\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked source\n");
    await fs.writeFile(path.join(repo, "private.txt"), "ignored source\n");
    await fs.writeFile(path.join(repo, ".env.local"), "first\n");
    if (process.platform !== "win32") {
      await fs.mkdir(path.join(repo, ".openclaw"));
      await fs.writeFile(
        path.join(repo, ".openclaw", "worktree-setup.sh"),
        '#!/bin/sh\nprintf "%s" "$OPENCLAW_WORKTREE_PATH" > setup-ran.txt\n',
        { mode: 0o755 },
      );
    }

    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    expect(template?.status).toBe("ready");
    await fs.writeFile(path.join(repo, ".env.local"), "second\n");
    await fs.writeFile(path.join(first.path, "README.md"), "first checkout edit\n");
    const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });

    expect(backend.createTemplate).toHaveBeenCalledTimes(1);
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
    expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe(
      "first checkout edit\n",
    );
    expect(await fs.readFile(path.join(first.path, ".env.local"), "utf8")).toBe("first\n");
    expect(await fs.readFile(path.join(second.path, ".env.local"), "utf8")).toBe("second\n");
    for (const name of ["untracked.txt", "private.txt"]) {
      await expect(fs.access(path.join(second.path, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const name of [".env.local", "setup-ran.txt"]) {
      await expect(fs.access(path.join(template.path, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    if (process.platform !== "win32") {
      for (const record of [first, second]) {
        expect(await fs.readFile(path.join(record.path, "setup-ran.txt"), "utf8")).toBe(
          record.path,
        );
      }
    }
    expect(await git(second.path, "status", "--porcelain")).toBe("");
    expect(await git(second.path, "symbolic-ref", "--short", "HEAD")).toBe(second.branch);
    await git(second.path, "checkout", "HEAD~1");
    await expect(fs.access(path.join(second.path, ".worktreeinclude"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("honors the opt-out without probing a filesystem backend", async () => {
    acceleration = false;
    const created = await service.create({ repoRoot: repo, name: "native", baseRef: "HEAD" });
    expect(detectWorktreeFilesystemBackend).not.toHaveBeenCalled();
    expect(listTemplates(env)).toEqual([]);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it("uses native Git when the repository configures a checkout filter", async () => {
    await git(repo, "config", "filter.fixture.required", "true");
    const created = await service.create({ repoRoot: repo, name: "filtered", baseRef: "HEAD" });

    expect(backend.createTemplate).not.toHaveBeenCalled();
    expect(backend.cloneTemplate).not.toHaveBeenCalled();
    expect(listTemplates(env)).toEqual([]);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await git(created.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
  });

  it("replaces stale source and expires its template without removing live manual worktrees", async () => {
    const first = await service.create({ repoRoot: repo, name: "old", baseRef: "HEAD" });
    const original = listTemplates(env)[0];
    assert(original);
    await fs.writeFile(path.join(repo, "README.md"), "new commit\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "change source");
    const second = await service.create({ repoRoot: repo, name: "new", baseRef: "HEAD" });
    const templates = listTemplates(env);
    expect(templates).toHaveLength(1);
    const replacement = templates[0];
    assert(replacement);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.sourceCommit).toBe(await git(repo, "rev-parse", "HEAD"));
    await expect(fs.access(original.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("new commit\n");

    now += IDLE_GC_MS + 1;
    expect((await service.gc()).removed).toEqual([]);
    expect(listTemplates(env)).toEqual([]);
    await expect(fs.access(replacement.path)).rejects.toMatchObject({ code: "ENOENT" });
    for (const record of [first, second]) {
      expect(await git(record.path, "status", "--porcelain")).toBe("");
      expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
    }
  });

  it("cleans a partial snapshot and completes creation through native Git", async () => {
    vi.mocked(backend.cloneTemplate).mockImplementationOnce(async (_source, destination) => {
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "partial.txt"), "incomplete snapshot\n");
      throw new Error("filesystem snapshot failed");
    });
    const created = await service.create({ repoRoot: repo, name: "fallback", baseRef: "HEAD" });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    await expect(fs.access(path.join(created.path, "partial.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await git(created.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
    expect((await service.list()).map((entry) => entry.id)).toEqual([created.id]);
  });

  it.each([false, true])(
    "prunes expired snapshots despite an unavailable allocation lease with acceleration %s",
    async (enabled) => {
      acceleration = enabled;
      const created = await service.create({ repoRoot: repo, name: "expired", baseRef: "HEAD" });
      const removed = await service.remove({ id: created.id, reason: "retention" });
      now += SNAPSHOT_RETENTION_MS + 1;
      vi.spyOn(stateLease, "withOpenClawStateLease").mockRejectedValue(
        new Error("allocation lease unavailable"),
      );

      expect((await service.gc()).snapshotsPruned).toBe(1);
      expect(service.listRegistryRecords()).toEqual([]);
      await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
      expect(listTemplates(env)).toHaveLength(enabled ? 1 : 0);
    },
  );

  it("removes its registration and branch when snapshot and native fallback both fail", async () => {
    vi.mocked(backend.cloneTemplate).mockRejectedValueOnce(new Error("snapshot unavailable"));
    let failedDestination: string | undefined;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv.includes("reset") && argv.includes("--hard")) {
        failedDestination = argv[argv.indexOf("-C") + 1];
        return {
          stdout: "",
          stderr: "native checkout failed",
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return await realRunCommand(argv, options);
    });

    await expect(
      service.create({ repoRoot: repo, name: "failed-fallback", baseRef: "HEAD" }),
    ).rejects.toThrow("native checkout failed");
    expect(failedDestination).toBeDefined();
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("failed-fallback");
    expect(await git(repo, "branch", "--list", "openclaw/failed-fallback")).toBe("");
    expect(service.listRegistryRecords()).toEqual([]);
    await expect(fs.access(failedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["repository", "metadata"])(
    "expires an owned template after its %s disappears while preserving live worktree data",
    async (missing) => {
      const created = await service.create({ repoRoot: repo, name: "preserved", baseRef: "HEAD" });
      const template = listTemplates(env)[0];
      assert(template);
      await fs.writeFile(path.join(created.path, "README.md"), "irreplaceable worktree edit\n");
      const source = missing === "repository" ? repo : path.join(repo, ".git");
      await fs.rename(source, `${source}-moved`);
      now += IDLE_GC_MS + 1;

      expect((await service.gc()).removed).toEqual([]);
      expect(listTemplates(env)).toEqual([]);
      await expect(fs.access(template.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
        "irreplaceable worktree edit\n",
      );
      expect(service.listRegistryRecords()).toEqual([expect.objectContaining({ id: created.id })]);
      expect(service.listRegistryRecords()[0]?.removedAt).toBeUndefined();
    },
  );

  it("restores saved edits through an accelerated checkout with independent Git history", async () => {
    const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
    const originalCommit = await git(created.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(created.path, "README.md"), "saved edit\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "saved new file\n");
    await service.remove({ id: created.id, reason: "test" });
    const restored = await service.restore({ id: created.id });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(2);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalCommit);
    expect(await git(restored.path, "symbolic-ref", "--short", "HEAD")).toBe(created.branch);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "saved new file\n",
    );
    expect(await git(restored.path, "status", "--porcelain")).toContain("M README.md");
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("base\n");
  });

  it("uses current external Git attributes instead of reusing a cached checkout", async () => {
    await git(repo, "config", "core.autocrlf", "false");
    const first = await service.create({ repoRoot: repo, name: "before-attrs", baseRef: "HEAD" });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
    const configHome = path.join(path.dirname(repo), "git-config-home");
    await fs.mkdir(path.join(configHome, "git"), { recursive: true });
    await fs.writeFile(path.join(configHome, "git", "attributes"), "*.md text eol=crlf\n");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const second = await service.create({ repoRoot: repo, name: "after-attrs", baseRef: "HEAD" });
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\r\n");
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
  });
});

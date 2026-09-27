import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandExec from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as baseRefs from "./base-ref.js";
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import { addManagedWorktree } from "./checkout.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const realRunCommand = commandExec.runCommandWithTimeout;
async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("repository source profile creation", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let service: ManagedWorktreeService;
  let env: NodeJS.ProcessEnv;
  let commit: string;

  async function write(file: string, content: string) {
    const target = path.join(repo, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  async function save() {
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "profile inputs");
    return await git(repo, "rev-parse", "HEAD");
  }

  beforeEach(async () => {
    const root = roots.make("openclaw-source-profiles-");
    repo = await initializeRepository(root);
    await write("alpha/source.txt", "alpha\n");
    await write("beta/source.txt", "beta\n");
    await write("excluded/source.txt", "full-only\n");
    await write(".openclaw/worktree-profiles/alpha", "alpha\n");
    await write(".openclaw/worktree-profiles/both", "beta\nalpha\n");
    commit = await save();
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  it("composes pinned definitions and keeps full default, shared history and independent writes", async () => {
    await write(".openclaw/worktree-profiles/alpha", "excluded\n");
    const sparse = await service.create({
      repoRoot: repo,
      name: "sparse",
      baseRef: commit,
      profiles: ["both", "alpha", "both"],
    });
    expect(await git(sparse.path, "sparse-checkout", "list")).toBe(
      ".openclaw/worktree-profiles\nalpha\nbeta",
    );
    expect(await fs.readFile(path.join(sparse.path, "alpha/source.txt"), "utf8")).toBe("alpha\n");
    await expect(fs.access(path.join(sparse.path, "excluded/source.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(sparse.path, "status", "--porcelain")).toBe("");
    expect(await git(sparse.path, "rev-parse", "HEAD")).toBe(commit);
    expect(await git(sparse.path, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(await git(sparse.path, "merge-base", "HEAD", "main")).toBe(commit);
    expect(await git(sparse.path, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
      await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const full = await service.create({ repoRoot: repo, name: "full", baseRef: commit });
    expect(await fs.readFile(path.join(full.path, "excluded/source.txt"), "utf8")).toBe(
      "full-only\n",
    );
    expect(
      await git(sparse.path, "rev-parse", "--path-format=absolute", "--git-path", "index"),
    ).not.toBe(await git(full.path, "rev-parse", "--path-format=absolute", "--git-path", "index"));
    await fs.writeFile(path.join(sparse.path, "alpha/source.txt"), "task edit\n");
    expect(await fs.readFile(path.join(full.path, "alpha/source.txt"), "utf8")).toBe("alpha\n");
    expect(await fs.readFile(path.join(repo, "alpha/source.txt"), "utf8")).toBe("alpha\n");
    await git(sparse.path, "sparse-checkout", "disable");
    expect(await fs.readFile(path.join(sparse.path, "excluded/source.txt"), "utf8")).toBe(
      "full-only\n",
    );
    expect(await fs.readFile(path.join(sparse.path, "alpha/source.txt"), "utf8")).toBe(
      "task edit\n",
    );
  });

  it.each(["../excluded\n", "/excluded\n", "alpha/source.txt\n", "missing\n", "alpha/*\n"])(
    "rejects invalid cone data before target or branch registration: %j",
    async (definition) => {
      await write(".openclaw/worktree-profiles/bad", definition);
      await save();
      await expect(
        service.create({
          repoRoot: repo,
          name: "invalid",
          baseRef: "HEAD",
          profiles: ["bad"],
        }),
      ).rejects.toThrow(/directory/);
      expect(await git(repo, "branch", "--list", "openclaw/invalid")).toBe("");
      expect(await service.listRegistryRecords()).toEqual([]);
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("/invalid");
    },
  );

  it("applies sparse source before ignored provisioning and never reshrinks on named reuse", async () => {
    await write(".gitignore", "excluded/sentinel\n");
    await write(".worktreeinclude", "excluded/sentinel\n");
    await save();
    await write("excluded/sentinel", "provisioned bytes\n");
    const sparse = await service.create({
      repoRoot: repo,
      name: "prepared",
      baseRef: "HEAD",
      profiles: ["alpha"],
    });
    expect(await fs.readFile(path.join(sparse.path, "excluded/sentinel"), "utf8")).toBe(
      "provisioned bytes\n",
    );
    await expect(fs.access(path.join(sparse.path, "excluded/source.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const before = await service.listRegistryRecords();
    await expect(
      service.create({
        repoRoot: repo,
        name: "prepared",
        profiles: ["both"],
      }),
    ).rejects.toThrow(/new worktree/);
    expect(await service.listRegistryRecords()).toEqual(before);
    expect(await fs.readFile(path.join(sparse.path, "excluded/sentinel"), "utf8")).toBe(
      "provisioned bytes\n",
    );
    expect((await service.create({ repoRoot: repo, name: "prepared" })).id).toBe(sparse.id);
    await git(sparse.path, "sparse-checkout", "disable");
    expect(await fs.readFile(path.join(sparse.path, "excluded/sentinel"), "utf8")).toBe(
      "provisioned bytes\n",
    );
    expect(await fs.readFile(path.join(sparse.path, "excluded/source.txt"), "utf8")).toBe(
      "full-only\n",
    );
  });

  it("does not reshrink a partially provisioned target after failed setup and failed cleanup", async () => {
    await write(".gitignore", "excluded/sentinel\nexcluded/setup-state\n");
    await write(".worktreeinclude", "excluded/sentinel\n");
    await write(".openclaw/worktree-setup.sh", "#!/bin/sh\nexit 0\n");
    await fs.chmod(path.join(repo, ".openclaw/worktree-setup.sh"), 0o755);
    await save();
    await write("excluded/sentinel", "retained provisioning\n");
    let target = "";
    let sparseCalls = 0;
    let setupCalls = 0;
    const failed = (stderr: string) => ({
      stdout: "",
      stderr,
      code: 1,
      signal: null,
      killed: false,
      termination: "exit" as const,
    });
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === path.join(repo, ".openclaw/worktree-setup.sh")) {
        setupCalls++;
        if (typeof options === "number" || !options.cwd) {
          throw new Error("setup command must name its working directory");
        }
        target = options.cwd;
        // Inspect real Git state and real copied bytes at the hook boundary.
        expect(await git(target, "sparse-checkout", "list")).toBe(
          ".openclaw/worktree-profiles\nalpha",
        );
        expect(await fs.readFile(path.join(target, "excluded/sentinel"), "utf8")).toBe(
          "retained provisioning\n",
        );
        await expect(fs.access(path.join(target, "excluded/source.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await fs.writeFile(path.join(target, "excluded/setup-state"), "partial setup\n");
        return failed("injected setup failure");
      }
      if (argv[0] === "git" && argv.includes("sparse-checkout") && argv.includes("set")) {
        sparseCalls++;
      }
      if (argv[0] === "git" && argv.includes("worktree") && argv.includes("remove")) {
        return failed("injected cleanup failure retains recovery");
      }
      return await realRunCommand(argv, options);
    });
    const params = { repoRoot: repo, name: "partial", baseRef: "HEAD", profiles: ["alpha"] };
    await expect(service.create(params)).rejects.toThrow(/setup failure/);
    expect(target).not.toBe("");
    expect(await service.listRegistryRecords()).toEqual([]);
    await expect(service.create({ ...params, profiles: ["both"] })).rejects.toThrow();
    expect(sparseCalls).toBe(1);
    expect(setupCalls).toBe(1);
    expect(await git(target, "sparse-checkout", "list")).toBe(".openclaw/worktree-profiles\nalpha");
    expect(await fs.readFile(path.join(target, "excluded/sentinel"), "utf8")).toBe(
      "retained provisioning\n",
    );
    expect(await fs.readFile(path.join(target, "excluded/setup-state"), "utf8")).toBe(
      "partial setup\n",
    );
  });

  it("rejects selected owner reuse and snapshot restore before changing ignored state", async () => {
    await write(".gitignore", "excluded/sentinel\n");
    await write(".worktreeinclude", "excluded/sentinel\n");
    await write("excluded/sentinel", "provisioned bytes\n");
    await save();
    const params = {
      repoRoot: repo,
      name: "owned",
      baseRef: "HEAD",
      ownerId: "owner",
      ownerKind: "session" as const,
    };
    const full = await service.create(params);
    await fs.writeFile(path.join(full.path, "excluded/sentinel"), "owned ignored bytes\n");
    await expect(
      service.create({ ...params, name: "different", profiles: ["alpha"] }),
    ).rejects.toThrow(/new worktree/);
    expect(await fs.readFile(path.join(full.path, "excluded/sentinel"), "utf8")).toBe(
      "owned ignored bytes\n",
    );
    await service.remove({ id: full.id, reason: "archive" });
    const before = await service.listRegistryRecords();
    expect(before[0]?.snapshotRef).toBeTruthy();
    await expect(service.create({ ...params, profiles: ["alpha"] })).rejects.toThrow(
      /new worktree/,
    );
    expect(await service.listRegistryRecords()).toEqual(before);
    const restored = await service.restore({ id: full.id });
    expect(await fs.readFile(path.join(restored.path, "excluded/sentinel"), "utf8")).toBe(
      "owned ignored bytes\n",
    );
    expect(await fs.readFile(path.join(restored.path, "excluded/source.txt"), "utf8")).toBe(
      "full-only\n",
    );
  });

  it.each(["existing", "restore"])(
    "rejects an unsafe low-level profile target before registration: %s",
    async (mode) => {
      const destination = path.join(roots.make("openclaw-profile-target-"), "target");
      if (mode === "existing") {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "sentinel"), "preserve\n");
      }
      const sourceProfile = await resolveWorktreeSourceProfile(repo, commit, ["alpha"], {
        commitGuard: () => undefined,
      });
      const requireSpace = vi.fn();
      await expect(
        addManagedWorktree({
          env,
          now: Date.now,
          enabled: false,
          repoRoot: repo,
          commonDir: await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
          worktreeRoot: path.dirname(destination),
          destination,
          base: commit,
          sourceProfile,
          deferGitCheckout: mode === "restore",
          requireSpace,
          commitGuard: () => undefined,
        }),
      ).rejects.toThrow(/fresh destination/);
      expect(requireSpace).not.toHaveBeenCalled();
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(destination);
      if (mode === "existing") {
        expect(await fs.readFile(path.join(destination, "sentinel"), "utf8")).toBe("preserve\n");
      }
    },
  );

  it("preserves unexpected content appearing after registration instead of shrinking or rolling it back", async () => {
    const destination = path.join(roots.make("openclaw-profile-race-"), "target");
    const sourceProfile = await resolveWorktreeSourceProfile(repo, commit, ["alpha"], {
      commitGuard: () => undefined,
    });
    let sparseCalls = 0;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv.includes("sparse-checkout")) {
        sparseCalls++;
      }
      const result = await realRunCommand(argv, options);
      if (
        argv[0] === "git" &&
        argv.includes("worktree") &&
        argv.includes("add") &&
        argv.includes(destination) &&
        result.code === 0
      ) {
        await fs.writeFile(path.join(destination, "sentinel"), "interrupted preparation\n");
      }
      return result;
    });
    await expect(
      addManagedWorktree({
        env,
        now: Date.now,
        enabled: false,
        repoRoot: repo,
        commonDir: await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        worktreeRoot: path.dirname(destination),
        destination,
        base: commit,
        sourceProfile,
        requireSpace: () => undefined,
        commitGuard: () => undefined,
      }),
    ).rejects.toThrow(/no longer unprepared/);
    expect(sparseCalls).toBe(0);
    expect(await fs.readFile(path.join(destination, "sentinel"), "utf8")).toBe(
      "interrupted preparation\n",
    );
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(destination);
  });

  it("preserves partial sparse materialization and refuses to shrink it on retry", async () => {
    await write(".gitignore", "excluded/sentinel\n");
    await save();
    let target = "";
    let sparseCalls = 0;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv.includes("sparse-checkout") && argv.includes("set")) {
        sparseCalls++;
      }
      if (argv[0] === "git" && argv.includes("read-tree") && argv.includes("--reset")) {
        // Git's executor selects its worktree with -C, not the process cwd.
        const directoryFlag = argv.indexOf("-C");
        const directory = directoryFlag >= 0 ? argv[directoryFlag + 1] : undefined;
        if (!directory) {
          throw new Error("Git materialization must select its worktree with -C");
        }
        target = directory;
        await fs.mkdir(path.join(target, "excluded"), { recursive: true });
        await fs.writeFile(path.join(target, "excluded/sentinel"), "partial recovery evidence\n");
        return {
          stdout: "",
          stderr: "injected partial materialization",
          code: 1,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      return await realRunCommand(argv, options);
    });
    const params = { repoRoot: repo, name: "partial-source", baseRef: "HEAD", profiles: ["alpha"] };
    await expect(service.create(params)).rejects.toThrow(/partial materialization/);
    expect(target).not.toBe("");
    expect(await fs.readFile(path.join(target, "excluded/sentinel"), "utf8")).toBe(
      "partial recovery evidence\n",
    );
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(target);
    expect(await service.listRegistryRecords()).toEqual([]);
    await expect(service.create({ ...params, profiles: ["both"] })).rejects.toThrow(
      /branch already exists/,
    );
    expect(sparseCalls).toBe(1);
    expect(await fs.readFile(path.join(target, "excluded/sentinel"), "utf8")).toBe(
      "partial recovery evidence\n",
    );
  });

  it.each(["../alpha", "Alpha", "", "alpha/beta", "--alpha", "alpha\n"])(
    "rejects unsafe profile names before source registration: %j",
    async (name) => {
      await expect(
        service.create({
          repoRoot: repo,
          name: "invalid-name",
          baseRef: commit,
          profiles: [name],
        }),
      ).rejects.toThrow(/lowercase name/);
      expect(await git(repo, "branch", "--list", "openclaw/invalid-name")).toBe("");
      expect(await service.listRegistryRecords()).toEqual([]);
    },
  );

  it("rejects invalid UTF-8 and oversized definitions instead of reading a valid prefix", async () => {
    for (const contents of [Buffer.from([0xff]), Buffer.from("alpha\n" + "\n".repeat(64 * 1024))]) {
      await fs.writeFile(path.join(repo, ".openclaw/worktree-profiles/bad"), contents);
      const pinned = await save();
      await expect(
        resolveWorktreeSourceProfile(repo, pinned, ["bad"], {
          commitGuard: () => undefined,
        }),
      ).rejects.toThrow();
    }
  });

  it.each([false, true])("reloads profiles at fallback HEAD; missing=%s", async (missing) => {
    if (missing) {
      await git(repo, "rm", ".openclaw/worktree-profiles/alpha");
    } else {
      await write(".openclaw/worktree-profiles/alpha", "beta\n");
    }
    const fallback = await save();
    vi.spyOn(baseRefs, "resolveWorktreeBase").mockResolvedValue({
      commit,
      gitOperand: commit,
      recordRef: "origin/main",
      remote: true,
    });
    let attempts = 0;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv.includes("worktree") && argv.includes("add")) {
        attempts++;
        if (attempts === 1) {
          return {
            stdout: "",
            stderr: "remote checkout failed",
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
      }
      return await realRunCommand(argv, options);
    });
    const result = service.create({ repoRoot: repo, name: "retry", profiles: ["alpha"] });
    if (missing) {
      await expect(result).rejects.toThrow(/tracked regular file/);
      expect(attempts).toBe(1);
      expect(await service.listRegistryRecords()).toEqual([]);
      expect(await git(repo, "branch", "--list", "openclaw/retry")).toBe("");
    } else {
      const target = await result;
      expect(attempts).toBe(2);
      expect(await git(target.path, "rev-parse", "HEAD")).toBe(fallback);
      expect(await git(target.path, "sparse-checkout", "list")).toBe(
        ".openclaw/worktree-profiles\nbeta",
      );
      await expect(fs.access(path.join(target.path, "alpha/source.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(target.baseRef).toBe("HEAD");
    }
  });

  it("refuses symlink profile definitions", async () => {
    // Git mode injection avoids host symlink privilege requirements.
    const blob = await git(repo, "rev-parse", commit + ":.openclaw/worktree-profiles/alpha");
    await git(
      repo,
      "update-index",
      "--add",
      "--cacheinfo",
      "120000," + blob + ",.openclaw/worktree-profiles/link",
    );
    await git(repo, "commit", "-m", "symlink profile");
    await expect(
      resolveWorktreeSourceProfile(repo, "HEAD", ["link"], {
        commitGuard: () => undefined,
      }),
    ).rejects.toThrow(/tracked regular file/);
  });
});

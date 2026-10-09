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
import { resolveWorktreeSourceProfile } from "./checkout-profiles.js";
import { addManagedWorktree } from "./checkout.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const realRunCommand = commandExec.runCommandWithTimeout;
async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

function read(root: string, file: string) {
  return fs.readFile(path.join(root, file), "utf8");
}

function failed(stderr: string) {
  return { stdout: "", stderr, code: 1, signal: null, killed: false, termination: "exit" as const };
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
  async function profileTarget(destination: string) {
    return {
      env,
      now: Date.now,
      enabled: false,
      repoRoot: repo,
      commonDir: await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      worktreeRoot: path.dirname(destination),
      destination,
      base: commit,
      sourceProfile: await resolveWorktreeSourceProfile(repo, commit, ["alpha"], {
        commitGuard: () => undefined,
      }),
      requireSpace: vi.fn(async () => {}),
      commitGuard: () => undefined,
    };
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

  it.each(["../excluded\n", "alpha/source.txt\n"])(
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
        expect(await read(target, "excluded/sentinel")).toBe("retained provisioning\n");
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
    expect(await read(target, "excluded/sentinel")).toBe("retained provisioning\n");
    expect(await read(target, "excluded/setup-state")).toBe("partial setup\n");
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
    expect(await read(full.path, "excluded/sentinel")).toBe("owned ignored bytes\n");
    await service.remove({ id: full.id, reason: "archive" });
    const before = await service.listRegistryRecords();
    expect(before[0]?.snapshotRef).toBeTruthy();
    await expect(service.create({ ...params, profiles: ["alpha"] })).rejects.toThrow(
      /new worktree/,
    );
    expect(await service.listRegistryRecords()).toEqual(before);
    const restored = await service.restore({ id: full.id });
    expect(await read(restored.path, "excluded/sentinel")).toBe("owned ignored bytes\n");
    expect(await read(restored.path, "excluded/source.txt")).toBe("full-only\n");
  });

  it("rejects an existing low-level profile target before registration", async () => {
    const destination = path.join(roots.make("openclaw-profile-target-"), "target");
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "sentinel"), "preserve\n");
    const input = await profileTarget(destination);
    await expect(addManagedWorktree(input)).rejects.toThrow(/fresh destination/);
    expect(input.requireSpace).not.toHaveBeenCalled();
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(destination);
    expect(await read(destination, "sentinel")).toBe("preserve\n");
  });

  it("preserves unexpected content appearing after registration instead of shrinking or rolling it back", async () => {
    const destination = path.join(roots.make("openclaw-profile-race-"), "target");
    const input = await profileTarget(destination);
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
    await expect(addManagedWorktree(input)).rejects.toThrow(/no longer unprepared/);
    expect(sparseCalls).toBe(0);
    expect(await read(destination, "sentinel")).toBe("interrupted preparation\n");
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
        return failed("injected partial materialization");
      }
      return await realRunCommand(argv, options);
    });
    const params = { repoRoot: repo, name: "partial-source", baseRef: "HEAD", profiles: ["alpha"] };
    await expect(service.create(params)).rejects.toThrow(/partial materialization/);
    expect(target).not.toBe("");
    expect(await read(target, "excluded/sentinel")).toBe("partial recovery evidence\n");
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(target);
    expect(await service.listRegistryRecords()).toEqual([]);
    await expect(service.create({ ...params, profiles: ["both"] })).rejects.toThrow(
      /branch already exists/,
    );
    expect(sparseCalls).toBe(1);
    expect(await read(target, "excluded/sentinel")).toBe("partial recovery evidence\n");
  });

  it("rejects an escaping profile name before source registration", async () => {
    await expect(
      service.create({
        repoRoot: repo,
        name: "invalid-name",
        baseRef: commit,
        profiles: ["../alpha"],
      }),
    ).rejects.toThrow(/lowercase name/);
    expect(await git(repo, "branch", "--list", "openclaw/invalid-name")).toBe("");
    expect(await service.listRegistryRecords()).toEqual([]);
  });

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

  it("reports a failed remote checkout without retrying from local HEAD", async () => {
    await git(repo, "push", "origin", `${commit}:refs/heads/main`);
    await write(".openclaw/worktree-profiles/alpha", "beta\n");
    await save();
    const attemptedBases: string[] = [];
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "git" && argv.includes("worktree") && argv.includes("add")) {
        attemptedBases.push(argv.at(-1)!);
        return failed("remote checkout failed");
      }
      return await realRunCommand(argv, options);
    });
    await expect(
      service.create({ repoRoot: repo, name: "retry", profiles: ["alpha"] }),
    ).rejects.toThrow("remote checkout failed");
    expect(attemptedBases).toEqual([commit]);
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/retry")).toBe("");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import * as execRunner from "../../process/exec-runner.js";
import * as processExec from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { resolveWorktreeBase } from "./base-ref.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { gitIdentity } from "./git-fixture.test-support.js";
import {
  commandError,
  findGitCheckoutRoot,
  gitEnvironment,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
  listGitWorktrees,
  readGitWorktreePathInventory,
  requireGit,
  resolveGitRepositoryPaths,
  runGit,
  runGitBuffered,
  runGitBytes,
} from "./git.js";

const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Git ref mutation ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const snapshotRef = "refs/openclaw/snapshots/held";
  const queuedRef = "refs/openclaw/snapshots/queued";
  const transports = [
    ["text", runGit],
    ["bytes", runGitBytes],
    ["buffered", runGitBuffered],
  ] as const;

  async function repository() {
    const root = tempDirs.make("openclaw-git-ref-");
    await git(root, "init", "--quiet", "-b", "main");
    await git(
      root,
      ...gitIdentity,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    );
    await git(root, "update-ref", snapshotRef, "HEAD");
    await git(root, "update-ref", queuedRef, "HEAD");
    return root;
  }

  it.each([false, true])(
    "preserves Git configuration policy (sourceOnly=%s)",
    async (sourceOnly) => {
      const root = await repository();
      const layout = new Map([
        ["core.symlinks", String(process.platform === "win32")],
        ["core.excludesfile", ' leading "quote"\\path\n\t\b#; trailing '],
        ["core.eol", "lf"],
      ]);
      for (const [key, value] of layout) {
        await git(root, "config", key, value);
      }
      await git(root, "config", "gc.auto", "1");
      await git(root, "config", "maintenance.auto", "true");
      await git(root, "config", "--add", "core.eol", "crlf");
      layout.set("core.eol", "crlf").set("gc.auto", "0").set("maintenance.auto", "false");
      await git(root, "config", "filter.unsafe.clean", "must-not-run");
      const original = await fs.readFile(path.join(root, ".git", "config"));
      const commands = vi.spyOn(processExec, "runCommandWithTimeout");
      await withWorktreeGitConfig(root, sourceOnly, {}, async (policy) => {
        const result = await policy.run(root, ["config", "--null", "--list"]);
        expect(result.code).toBe(0);
        const values = Object.fromEntries(
          result.stdout
            .split("\0")
            .filter(Boolean)
            .map((field) => {
              const split = field.indexOf("\n");
              return [field.slice(0, split), field.slice(split + 1)];
            }),
        );
        expect(values).toMatchObject(Object.fromEntries(layout));
        expect(values["filter.unsafe.clean"]).toBe(sourceOnly ? undefined : "must-not-run");
      });
      expect(commands.mock.calls.filter(([argv]) => argv.includes("--file"))).toHaveLength(0);
      expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(original);
    },
  );

  function holdSnapshotDeletion(failure?: Error, discoverySignal?: AbortSignal) {
    const started = createDeferred();
    const release = createDeferred();
    const discovered = createDeferred<{ code: number | null; termination: string }>();
    const mutations: Array<{ cwd: string; args: string[] }> = [];
    const run = processExec.runCommandWithTimeout;
    const recordDiscovery = (
      argv: string[],
      options: number | { signal?: AbortSignal },
      result: { code: number | null; termination: string },
    ) => {
      const commandIndex = argv.indexOf("-C") + 2;
      if (
        discoverySignal &&
        typeof options !== "number" &&
        options.signal === discoverySignal &&
        argv[commandIndex] === "rev-parse" &&
        argv[commandIndex + 1] === "--git-common-dir"
      ) {
        discovered.resolve(result);
      }
    };
    let held = false;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const args = argv.slice(argv.indexOf("-C") + 2);
      if (args[0] === "update-ref" || (args[0] === "branch" && args[1] === "-D")) {
        mutations.push({ cwd: argv[argv.indexOf("-C") + 1]!, args });
        if (!held && args[0] === "update-ref" && args[2] === snapshotRef) {
          held = true;
          started.resolve();
          await release.promise;
          if (failure) {
            throw failure;
          }
        }
      }
      const result = await run(argv, options);
      recordDiscovery(argv, options, result);
      return result;
    });
    if (discoverySignal) {
      const runBytes = execRunner.runCommandBuffersWithTimeout;
      vi.spyOn(execRunner, "runCommandBuffersWithTimeout").mockImplementation(
        async (argv, options) => {
          const result = await runBytes(argv, options);
          recordDiscovery(argv, options, result);
          return result;
        },
      );
      const runBuffered = processExec.runCommandBuffered;
      vi.spyOn(processExec, "runCommandBuffered").mockImplementation(async (argv, options = {}) => {
        const result = await runBuffered(argv, options);
        recordDiscovery(argv, options, result);
        return result;
      });
    }
    return { started, release, discovered, mutations };
  }

  it("rejects cancelled discovery with exit code zero without deleting the requested ref", async () => {
    const root = await repository();
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce(
      createCommandResult({ stdout: ".git\n", termination: "signal" }),
    );

    await expect(git(root, "update-ref", "-d", queuedRef)).rejects.toThrow(
      `git update-ref -d ${queuedRef} failed (terminated):\n.git`,
    );
    expect(await git(root, "show-ref", "--verify", queuedRef)).toContain(queuedRef);
  });

  it.runIf(process.platform === "win32")(
    "normalizes MSYS common-directory output while preserving a literal revision mutation",
    async () => {
      const root = await repository();
      const commonDir = await fs.realpath(path.join(root, ".git"));
      expect(commonDir).toMatch(/^[a-zA-Z]:[\\/]/u);
      const msysCommonDir = `/${commonDir[0]!.toLowerCase()}${commonDir.slice(2).replaceAll("\\", "/")}`;
      const run = processExec.runCommandWithTimeout;
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await run(argv, options);
        const commandIndex = argv.indexOf("-C") + 2;
        if (argv[commandIndex] === "rev-parse" && argv[commandIndex + 1] === "--git-common-dir") {
          return { ...result, stdout: `${msysCommonDir}\n` };
        }
        return result;
      });
      await requireGit(root, ["update-ref", queuedRef, "HEAD^{commit}"], {
        env: { MSYS: "winsymlinks:nativestrict", CYGWIN: "disable_pcon" },
      });
      expect(await git(root, "rev-parse", queuedRef)).toBe(await git(root, "rev-parse", "HEAD"));
    },
  );

  it("serializes snapshot and branch deletes across checkout aliases without blocking other repositories or reads", async () => {
    const root = await repository();
    const other = await repository();
    const linked = path.join(root, "linked");
    const alias = path.join(tempDirs.make("openclaw-git-alias-"), "repo");
    await git(root, "worktree", "add", "--detach", linked, "HEAD");
    await git(root, "branch", "retired", "HEAD");
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const held = holdSnapshotDeletion();
    const first = runGit(root, ["update-ref", "-d", snapshotRef]);
    const pending: Promise<unknown>[] = [first];
    try {
      await held.started.promise;
      pending.push(git(linked, "branch", "-D", "retired"));
      pending.push(
        requireGit(alias, ["update-ref", "--stdin"], { input: `delete ${queuedRef}\n` }),
      );
      await git(other, "update-ref", "-d", queuedRef);
      await expect(git(linked, "rev-parse", "HEAD")).resolves.toMatch(/^[a-f0-9]+$/);
      expect(held.mutations.filter((call) => call.cwd !== other)).toEqual([
        { cwd: root, args: ["update-ref", "-d", snapshotRef] },
      ]);
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
    }
    await expect(first).resolves.toMatchObject({ code: 0 });
    await Promise.all(pending);
    expect(await git(root, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(await git(other, "show-ref", "--verify", snapshotRef)).toContain(snapshotRef);
  });

  it("rejects an interrupted explicit-base lookup even with exit code zero", async () => {
    const root = await repository();
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce(
      createCommandResult({ stdout: "refs/heads/-fixture\n", termination: "signal" }),
    );
    await expect(resolveWorktreeBase(root, "-fixture")).rejects.toThrow("terminated");
  });

  it("registers a tracking worktree after the shared ref writer releases config", async ({
    signal,
  }) => {
    const root = await repository();
    await git(root, "remote", "add", "origin", root);
    await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const controller = new AbortController();
    const held = holdSnapshotDeletion(undefined, controller.signal);
    const mutation = runGit(root, ["update-ref", "-d", snapshotRef]);
    let creation: Promise<unknown> | undefined;
    const lock = path.join(root, ".git", "config.lock");
    const destination = path.join(root, "tracking");
    try {
      await held.started.promise;
      await fs.writeFile(lock, "", { flag: "wx" });
      creation = requireGit(
        root,
        [
          "worktree",
          "add",
          "--no-checkout",
          "-b",
          "tracking",
          "--",
          destination,
          "refs/remotes/origin/main",
        ],
        { signal: controller.signal },
      );
      await withinTest(
        awaitGateBeforeSettlement(
          held.discovered.promise,
          creation,
          "worktree registration bypassed its ref writer",
        ),
        signal,
      );
    } finally {
      await fs.rm(lock, { force: true });
      held.release.resolve();
      await Promise.allSettled([mutation, creation]);
    }
    await creation;
    expect(await git(destination, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
      "refs/remotes/origin/main",
    );
  });

  it("does not accept an interrupted cached remote HEAD", async () => {
    const root = await repository();
    await git(root, "remote", "add", "origin", path.join(root, "missing.git"));
    const run = processExec.runCommandWithTimeout;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation((argv, options) => {
      const command = argv[argv.indexOf("-C") + 2];
      if (command !== "symbolic-ref") {
        return run(argv, options);
      }
      return Promise.resolve(
        createCommandResult({ stdout: "refs/remotes/origin/main\n", termination: "signal" }),
      );
    });
    await expect(resolveWorktreeBase(root)).rejects.toThrow("Remote default branch is unavailable");
  });

  it("serializes bounded default-branch fetching without pruning unrelated refs", async () => {
    const root = await repository();
    const origin = await repository();
    const staleRef = "refs/remotes/origin/retired";
    await git(origin, "branch", "retired", "HEAD");
    await git(root, "remote", "add", "origin", origin);
    await git(root, "fetch", "origin");
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git(root, "config", "fetch.prune", "true");
    await git(root, "pack-refs", "--all");
    expect(await fs.readFile(path.join(root, ".git", "packed-refs"), "utf8")).toContain(staleRef);
    await git(origin, "branch", "-D", "retired");
    const originHead = await git(origin, "rev-parse", "HEAD");

    const controller = new AbortController();
    const held = holdSnapshotDeletion(undefined, controller.signal);
    const pending: Promise<unknown>[] = [runGit(root, ["update-ref", "-d", snapshotRef])];
    let resolved: ReturnType<typeof resolveWorktreeBase> | undefined;
    try {
      await held.started.promise;
      resolved = resolveWorktreeBase(root, undefined, controller.signal);
      pending.push(resolved);
      await expect(
        awaitGateBeforeSettlement(
          held.discovered.promise,
          resolved,
          "fetch completed before its queued discovery barrier",
        ),
      ).resolves.toMatchObject({ code: 0, termination: "exit" });
      await expect(git(root, "show-ref", "--verify", staleRef)).resolves.toContain(staleRef);
      expect(held.mutations).toEqual([{ cwd: root, args: ["update-ref", "-d", snapshotRef] }]);
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
    }
    await Promise.all(pending);
    await expect(resolved).resolves.toMatchObject({
      commit: originHead,
      gitOperand: "refs/remotes/origin/main",
      recordRef: "origin/main",
      fetchSucceeded: true,
    });
    await expect(
      runGit(root, ["show-ref", "--verify", "--quiet", staleRef]),
    ).resolves.toMatchObject({
      code: 0,
    });
  });

  it.each(transports)(
    "%s releases a rejected mutation and leaves a cancelled waiting branch deletion unexecuted",
    async (_transport, run) => {
      const root = await repository();
      await git(root, "branch", "kept", "HEAD");
      const failure = new Error("Git executor unavailable");
      const controller = new AbortController();
      const held = holdSnapshotDeletion(failure, controller.signal);
      const rejected = expect(git(root, "update-ref", "-d", snapshotRef)).rejects.toBe(failure);
      const pending: Promise<unknown>[] = [rejected];
      let cancelled: ReturnType<typeof run> | undefined;
      try {
        await held.started.promise;
        cancelled = run(root, ["branch", "-D", "kept"], { signal: controller.signal });
        pending.push(cancelled, git(root, "update-ref", "-d", queuedRef));
        // Abort only after this candidate's real discovery settles; a separate read
        // can finish first and accidentally cancel discovery instead of the writer.
        await expect(
          awaitGateBeforeSettlement(
            held.discovered.promise,
            cancelled,
            "branch mutation completed before its queued discovery barrier",
          ),
        ).resolves.toMatchObject({ code: 0, termination: "exit" });
        expect(held.mutations).toEqual([{ cwd: root, args: ["update-ref", "-d", snapshotRef] }]);
        controller.abort();
        await expect(cancelled).resolves.toMatchObject({
          code: null,
          termination: "signal",
          killed: false,
        });
      } finally {
        held.release.resolve();
        await Promise.allSettled(pending);
      }
      await Promise.all(pending);
      expect(await git(root, "show-ref", "--verify", "refs/heads/kept")).toContain(
        "refs/heads/kept",
      );
      expect((await runGit(root, ["show-ref", "--verify", "--quiet", queuedRef])).code).toBe(1);
    },
  );

  it.each(transports)(
    "%s preserves authority errors when the admitted callback also aborts",
    async (_transport, run) => {
      const root = await repository();
      const controller = new AbortController();
      const revoked = new Error("Git mutation authority revoked");
      const beforeRun = vi.fn(() => {
        controller.abort(revoked);
        throw revoked;
      });
      await expect(
        run(root, ["update-ref", "-d", queuedRef], { signal: controller.signal, beforeRun }),
      ).rejects.toBe(revoked);
      expect(beforeRun).toHaveBeenCalledOnce();
      expect(await git(root, "show-ref", "--verify", queuedRef)).toContain(queuedRef);
    },
  );

  it("keeps discovery and queued mutation in the captured Git environment", async () => {
    vi.stubEnv("GIT_COMMON_DIR", undefined);
    const root = await repository();
    const other = await repository();
    const held = holdSnapshotDeletion();
    const first = runGit(root, ["update-ref", "-d", snapshotRef]);
    const pending: Promise<unknown>[] = [first];
    try {
      await held.started.promise;
      pending.push(git(root, "update-ref", "-d", queuedRef));
      // A newly introduced authority variable must not redirect a queued command
      // after its repository identity and inherited environment were captured.
      vi.stubEnv("GIT_COMMON_DIR", path.join(other, ".git"));
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
      vi.stubEnv("GIT_COMMON_DIR", undefined);
    }
    await Promise.all(pending);
    expect((await runGit(root, ["show-ref", "--verify", "--quiet", queuedRef])).code).toBe(1);
    expect(await git(other, "show-ref", "--verify", queuedRef)).toContain(queuedRef);
  });
});

describe("Git execution environment", () => {
  it.each([
    ["win32", ["rev-parse", "--verify", "HEAD^{commit}"], "winsymlinks:nativestrict", " noglob"],
    ["win32", ["status"], "winsymlinks:nativestrict", ""],
    ["linux", ["rev-parse", "HEAD^{commit}"], "winsymlinks:native", ""],
  ] as const)("preserves revisions on %s for %j", (platform, args, msys, suffix) => {
    expect(gitEnvironment({ MSYS: msys, CYGWIN: "disable_pcon" }, args, platform)).toMatchObject({
      MSYS: `${msys}${suffix}`,
      CYGWIN: `disable_pcon${suffix}`,
    });
  });

  it.each([
    ["noglob glob:ignorecase", "noglob glob:ignorecase noglob"],
    ["winsymlinks:native noglob", "winsymlinks:native noglob"],
  ])("keeps noglob final for %s", (value, expected) => {
    expect(gitEnvironment({ MSYS: value }, ["rev-parse", "HEAD^{commit}"], "win32").MSYS).toBe(
      expected,
    );
  });

  it("merges inherited Windows runtime options before preserving revisions", () => {
    expect(
      gitEnvironment(
        { GIT_INDEX_FILE: "snapshot.index", msys: "winsymlinks:native", CYGWIN: undefined },
        ["rev-parse", "HEAD^{commit}"],
        "win32",
        { MSYS: "winsymlinks:nativestrict", CYGWIN: "disable_pcon" },
      ),
    ).toMatchObject({
      GIT_INDEX_FILE: "snapshot.index",
      MSYS: "winsymlinks:native noglob",
      CYGWIN: "noglob",
    });
  });
});

describe("Git checkout discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports a real Git failure with execution metadata through the worktree wrapper", async () => {
    const root = tempDirs.make("openclaw-git-error-");
    const result = await runGit(path.join(root, "missing"), ["status"]);

    expectTypeOf(result).toMatchTypeOf<SpawnResult>();
    expect(result.timeoutMs).toBe(120_000);
    expect(result.code).toBe(128);
    expect(result).toMatchObject({ termination: "exit", signal: null });
    const message = commandError("git status", result).message;
    expect(message).toContain("git status failed (exit code 128)");
    expect(message).toContain("fatal:");
    expect(message).not.toMatch(/timeout|timed out/i);
  });

  it("returns the nearest checkout root for nested paths", async () => {
    const root = tempDirs.make("openclaw-git-root-");
    const nested = path.join(root, "packages", "nested");
    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(nested, { recursive: true });

    expect(findGitCheckoutRoot(nested)).toBeNull();
    expect(insideGitCheckout(nested)).toBe(false);
    await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(findGitCheckoutRoot(nested)).toBe(root);
    expect(insideGitCheckout(nested)).toBe(true);
  });

  it("distinguishes contained metadata from linked checkout pointers", async () => {
    const root = tempDirs.make("openclaw-git-metadata-");
    await fs.mkdir(path.join(root, ".git"));
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(true);

    await fs.rm(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /outside/worktrees/card\n", "utf8");
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(false);
  });

  it.for(["files", "reftable"] as const)(
    "parses native %s worktree paths, locks, symbolic heads, and detached tips",
    async (refStorage, context) => {
      const root = tempDirs.make("openclaw-git-worktree-list-");
      const repo = path.join(root, "repo");
      const linked = path.join(root, "linked");
      const detached = path.join(root, "detached");
      const initialized = await runGit(root, [
        "init",
        "--template=",
        ...(refStorage === "reftable" ? ["--ref-format=reftable"] : []),
        "-b",
        "main",
        repo,
      ]);
      if (
        refStorage === "reftable" &&
        initialized.termination === "exit" &&
        initialized.code !== 0 &&
        /unknown option.*ref-format|unknown ref storage format.*reftable/u.test(initialized.stderr)
      ) {
        context.skip("Installed Git does not support reftable repositories");
      }
      expect(initialized.code, initialized.stderr).toBe(0);
      await requireGit(repo, ["config", "user.name", "OpenClaw Test"]);
      await requireGit(repo, ["config", "user.email", "openclaw-test@example.invalid"]);
      await requireGit(repo, ["config", "commit.gpgSign", "false"]);
      await fs.writeFile(path.join(repo, "README.md"), "base\n");
      await requireGit(repo, ["add", "README.md"]);
      await requireGit(repo, ["commit", "-m", "initial"]);
      const initialHead = await requireGit(repo, ["rev-parse", "HEAD"]);
      await requireGit(repo, ["worktree", "add", "-b", "linked", linked, "HEAD"]);
      await requireGit(repo, ["worktree", "add", "--detach", detached, "HEAD"]);
      await requireGit(linked, ["commit", "--allow-empty", "-m", "linked tip"]);
      const linkedHead = await requireGit(linked, ["rev-parse", "HEAD"]);
      await requireGit(repo, ["symbolic-ref", "refs/heads/alias-middle", "refs/heads/linked"]);
      await requireGit(repo, ["symbolic-ref", "refs/heads/alias", "refs/heads/alias-middle"]);
      await requireGit(linked, ["symbolic-ref", "HEAD", "refs/heads/alias"]);
      await requireGit(repo, ["worktree", "lock", "--reason", "held by test", linked]);

      // These fixtures exist; compare identity without imposing Git's separator spelling.
      const worktrees = await listGitWorktrees(repo);
      for (const entry of worktrees) {
        entry.path = await fs.realpath(entry.path);
      }
      expect(worktrees).toEqual(
        expect.arrayContaining([
          { path: await fs.realpath(repo), branch: "refs/heads/main", head: initialHead },
          {
            path: await fs.realpath(linked),
            lockedReason: "held by test",
            branch: "refs/heads/linked",
            head: linkedHead,
          },
          { path: await fs.realpath(detached), branch: null, head: initialHead },
        ]),
      );
      const normalized = vi.spyOn(gitExec, "normalizeGitPathForFilesystem");
      await expect(resolveGitRepositoryPaths(linked)).resolves.toEqual({
        canonicalRoot: await fs.realpath(repo),
        commonDir: await fs.realpath(path.join(repo, ".git")),
      });
      // The common directory and primary checkout are the only paths this reader consumes.
      expect(normalized).toHaveBeenCalledTimes(2);
      const detachedPath = await fs.realpath(detached);
      await fs.rm(detached, { recursive: true });
      const paths = await readGitWorktreePathInventory(repo);
      normalized.mockClear();
      expect(paths.has(await fs.realpath(linked))).toBe(true);
      expect(paths.has(detachedPath)).toBe(true);
      expect(paths.has(`${detachedPath}-sibling`)).toBe(false);
      expect(normalized).not.toHaveBeenCalled();
    },
  );
});

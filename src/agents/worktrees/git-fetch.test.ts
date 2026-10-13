import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeGitCommand, requireGitCommandOutput } from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as processExec from "../../process/exec.js";
import {
  ensureProjectCheckoutCommit,
  refreshProjectCheckout,
} from "../../projects/project-clone-runtime.js";
import { resolveWorktreeBase } from "./base-ref.js";
import { runGit } from "./git.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1" };

async function git(cwd: string, args: string[]) {
  return requireGitCommandOutput("fixture git", await executeGitCommand(cwd, args, { env })).trim();
}

async function brokenClone() {
  const root = tempDirs.make("openclaw-broken-tip-");
  const source = path.join(root, "source");
  const clone = path.join(root, "clone");
  await git(root, ["init", "-b", "main", source]);
  await git(source, ["config", "user.name", "OpenClaw Test"]);
  await git(source, ["config", "user.email", "test@example.invalid"]);
  await git(source, ["config", "commit.gpgSign", "false"]);
  await git(source, ["config", "uploadpack.allowFilter", "true"]);
  await git(source, ["commit", "--allow-empty", "-m", "base"]);
  const base = await git(source, ["rev-parse", "HEAD"]);
  const url = pathToFileURL(source).href;
  await git(root, ["clone", "--filter=blob:none", "--no-checkout", url, clone]);
  await git(source, ["commit", "--allow-empty", "-m", "remote tip"]);
  const tip = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["branch", "keep"]);
  const objects = path.join(clone, ".git", "objects");
  const copyCommit = async (oid: string) => {
    const relative = path.join(oid.slice(0, 2), oid.slice(2));
    await fs.mkdir(path.dirname(path.join(objects, relative)), { recursive: true });
    await fs.copyFile(path.join(source, ".git", "objects", relative), path.join(objects, relative));
  };
  await copyCommit(tip);
  await git(clone, ["update-ref", "refs/remotes/origin/keep", tip]);
  await git(clone, ["update-ref", "refs/heads/retained", tip]);
  const linked = path.join(root, "linked");
  await git(clone, ["worktree", "add", "--detach", linked, tip]);
  const unborn = path.join(root, "unborn");
  await git(clone, ["worktree", "add", "--detach", unborn, base]);
  await git(unborn, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
  await git(source, ["commit", "--allow-empty", "-m", "retired remote tip"]);
  const retired = await git(source, ["rev-parse", "HEAD"]);
  await copyCommit(retired);
  await git(clone, ["update-ref", "refs/remotes/origin/retired", retired]);
  await git(source, ["update-ref", "refs/heads/main", tip]);
  await git(clone, ["commit-graph", "write", "--reachable"]);
  for (const oid of [tip, retired]) {
    await fs.unlink(path.join(objects, oid.slice(0, 2), oid.slice(2)));
  }
  return { clone, source, linked, url, base, tip, retired };
}

afterEach(() => vi.restoreAllMocks());

describe("shared repository missing-tip recovery", () => {
  it.each(["--dry-run", "--dry", "--dr"])(
    "keeps a %s fetch read-only even when the clone needs repair",
    async (dryRun) => {
      const { clone, retired, tip } = await brokenClone();
      const fetched = await runGit(clone, ["fetch", dryRun, "--no-auto-maintenance", "origin"], {
        env,
      });
      expect(fetched.code).toBe(128);
      expect(fetched.stderr).toContain(
        "which is in the commit graph file but not in the object database",
      );
      expect(
        await fs.readFile(path.join(clone, ".git", "refs/remotes/origin/retired"), "utf8"),
      ).toBe(`${retired}\n`);
      expect((await executeGitCommand(clone, ["cat-file", "-t", tip], { env })).code).not.toBe(0);
    },
  );

  it.each([
    "worktree",
    "project refresh",
    "renamed project branch",
    "pinned project commit",
  ] as const)(
    "repairs commit-graph-only tips through %s without removing local branches or detached HEADs",
    async (entry) => {
      const fixture = await brokenClone();
      const { clone, source, linked, url, base, tip } = fixture;
      if (entry === "renamed project branch") {
        await git(source, ["branch", "-m", "main", "renamed"]);
        await git(source, ["branch", "-D", "keep"]);
      }
      const before = await executeGitCommand(clone, ["fetch", "--no-auto-maintenance", "origin"], {
        env,
      });
      expect(before.code).toBe(128);
      expect(before.stderr).toContain(
        "which is in the commit graph file but not in the object database",
      );
      const start = performance.now();
      if (entry === "worktree") {
        // The live entry point inherits this variable from its process environment.
        vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
        try {
          const selected = await resolveWorktreeBase(clone);
          expect(selected.commit).toBe(tip);
          expect(selected.fetchSucceeded).toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      } else if (entry === "project refresh" || entry === "renamed project branch") {
        await refreshProjectCheckout({ target: clone, url }, { env });
        if (entry === "renamed project branch") {
          expect(await git(clone, ["rev-parse", "refs/remotes/origin/renamed"])).toBe(tip);
        }
      } else {
        await ensureProjectCheckoutCommit({ target: clone, url, commit: tip }, { env });
      }
      const elapsed = performance.now() - start;
      expect(await git(clone, ["cat-file", "-t", tip])).toBe("commit");
      expect(await git(clone, ["rev-parse", "refs/heads/main"])).toBe(base);
      expect(await git(clone, ["rev-parse", "refs/heads/retained"])).toBe(tip);
      expect(await git(linked, ["rev-parse", "HEAD"])).toBe(tip);
      expect(
        await git(clone, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/retired"]),
      ).toBe("");
      const after = await executeGitCommand(clone, ["fetch", "--no-auto-maintenance", "origin"], {
        env,
      });
      expect(after.code).toBe(0);
      console.info(
        `${entry}: before exit=${before.code}, after exit=${after.code}, recovery=${elapsed.toFixed(0)}ms`,
      );
    },
  );

  it("preserves custom tracking mappings while recovering missing tips", async () => {
    const { clone, source, tip } = await brokenClone();
    await git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    await git(source, ["update-ref", "-d", "refs/heads/main"]);
    await git(clone, [
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/keep:refs/remotes/origin/main",
    ]);
    expect((await runGit(clone, ["fetch", "--no-auto-maintenance", "origin"], { env })).code).toBe(
      0,
    );
    expect(await git(clone, ["rev-parse", "refs/remotes/origin/main"])).toBe(tip);
    expect(
      await git(clone, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/retired"]),
    ).toBe("refs/remotes/origin/retired");
  });

  it("repairs physical tips hidden by a replacement during project refresh", async () => {
    const { clone, url, base, tip } = await brokenClone();
    const replacement = `refs/replace/${tip}`;
    await git(clone, ["update-ref", replacement, base]);
    await refreshProjectCheckout({ target: clone, url }, { env });
    expect(await git(clone, ["--no-replace-objects", "cat-file", "-t", tip])).toBe("commit");
    expect(await git(clone, ["rev-parse", replacement])).toBe(base);
  });

  it("preserves tags and tracking refs when the caller disables configured pruning", async () => {
    const { clone, source, base, retired } = await brokenClone();
    await git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    await git(clone, ["tag", "local-only", base]);
    await git(clone, ["config", "fetch.prune", "true"]);
    await git(clone, ["config", "fetch.pruneTags", "true"]);
    expect(
      (await runGit(clone, ["fetch", "--no-auto-maintenance", "--no-prune", "origin"], { env }))
        .code,
    ).toBe(0);
    expect(await git(clone, ["rev-parse", "refs/tags/local-only"])).toBe(base);
    expect(await git(clone, ["rev-parse", "refs/remotes/origin/retired"])).toBe(retired);
  });

  it("does not treat an option value as permission to repair origin", async () => {
    const { clone, url, retired } = await brokenClone();
    await git(clone, ["remote", "add", "upstream", url]);
    await git(clone, ["config", "branch.main.remote", "upstream"]);
    await git(clone, ["config", "protocol.version", "2"]);
    const fetched = await runGit(clone, ["fetch", "--server-option", "origin"], { env });
    expect(fetched.code).toBe(128);
    expect(fetched.stderr).toContain(
      "which is in the commit graph file but not in the object database",
    );
    expect(await fs.readFile(path.join(clone, ".git", "refs/remotes/origin/retired"), "utf8")).toBe(
      `${retired}\n`,
    );
  });

  it("never follows an obsolete tracking ref replaced by a local-branch alias", async () => {
    const { clone, tip } = await brokenClone();
    const replacement = "refs/remotes/origin/retired2";
    await fs.writeFile(path.join(clone, ".git", replacement), `${tip}\n`);
    const run = processExec.runCommandWithTimeout;
    let replaced = false;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (!replaced && argv.includes("update-ref") && argv.includes("--stdin")) {
        replaced = true;
        await git(clone, ["symbolic-ref", replacement, "refs/heads/retained"]);
      }
      return run(argv, options);
    });
    await runGit(clone, ["fetch", "--no-auto-maintenance", "origin"], { env });
    expect(replaced).toBe(true);
    expect(await fs.readFile(path.join(clone, ".git", "refs/heads/retained"), "utf8")).toBe(
      `${tip}\n`,
    );
  });

  it.each([
    ["local symbolic branch", "fetch"],
    ["worktree HEAD", "fetch"],
    ["local symbolic branch", "project refresh"],
    ["worktree HEAD", "project refresh"],
  ] as const)(
    "retains an obsolete tracking ref required by a %s during %s",
    async (owner, operation) => {
      const { clone, source, linked, retired, url } = await brokenClone();
      await git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
      if (owner === "local symbolic branch") {
        await git(clone, [
          "symbolic-ref",
          "refs/remotes/origin/alias",
          "refs/remotes/origin/retired",
        ]);
        await git(clone, ["symbolic-ref", "refs/heads/local-alias", "refs/remotes/origin/alias"]);
      } else {
        await git(linked, ["symbolic-ref", "HEAD", "refs/remotes/origin/retired"]);
      }
      if (operation === "project refresh") {
        await refreshProjectCheckout({ target: clone, url }, { env });
      } else {
        expect(
          (await runGit(clone, ["fetch", "--no-auto-maintenance", "origin"], { env })).code,
        ).toBe(0);
      }
      expect(await git(clone, ["rev-parse", "refs/remotes/origin/retired"])).toBe(retired);
      expect(
        await git(owner === "local symbolic branch" ? clone : linked, [
          "rev-parse",
          owner === "local symbolic branch" ? "refs/heads/local-alias" : "HEAD",
        ]),
      ).toBe(retired);
    },
  );

  it("does not follow a tracking alias replaced immediately before project publication", async () => {
    const { clone, tip, url } = await brokenClone();
    expect((await runGit(clone, ["fetch", "--no-auto-maintenance", "origin"], { env })).code).toBe(
      0,
    );
    const replacement = "refs/remotes/origin/retired2";
    await git(clone, ["update-ref", replacement, tip]);
    const run = processExec.runCommandWithTimeout;
    let replaced = false;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (!replaced && argv.includes("for-each-ref") && argv[argv.indexOf("-C") + 1] !== clone) {
        replaced = true;
        await git(clone, ["symbolic-ref", replacement, "refs/heads/retained"]);
      }
      return result;
    });
    await refreshProjectCheckout({ target: clone, url }, { env });
    expect(replaced).toBe(true);
    expect(await git(clone, ["rev-parse", "refs/heads/retained"])).toBe(tip);
  });

  it.each(["unavailable", "uncertain"] as const)(
    "preserves local work when repair is %s",
    async (failure) => {
      const { clone, tip, linked } = await brokenClone();
      const logs = createWarnLogCapture("missing-tip-repair");
      const run = processExec.runCommandWithTimeout;
      const uncertain = new CommandProcessCleanupError();
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        if (argv.includes("fetch") && argv.includes("--stdin")) {
          if (failure === "uncertain") {
            throw uncertain;
          }
          return {
            stdout: "",
            stderr: "remote object unavailable",
            code: 128,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        return run(argv, options);
      });
      try {
        const operation = runGit(clone, ["fetch", "--no-auto-maintenance", "origin"], { env });
        if (failure === "uncertain") {
          await expect(operation).rejects.toBe(uncertain);
        } else {
          expect((await operation).code).toBe(128);
          expect(await logs.findText("Git repository repair failed")).toContain(
            "Local branches and worktree HEADs were preserved",
          );
        }
        expect(await fs.readFile(path.join(clone, ".git", "refs/heads/retained"), "utf8")).toBe(
          `${tip}\n`,
        );
        expect(await git(linked, ["rev-parse", "HEAD"])).toBe(tip);
      } finally {
        logs.cleanup();
      }
    },
  );
});

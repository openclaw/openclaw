import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const fetchArgs = ["fetch", "--no-auto-maintenance", "origin"];
const fetch = (...flags: string[]) =>
  runGit(clone, ["fetch", "--no-auto-maintenance", ...flags, "origin"], { env });
const ref = (cwd: string, name: string) => git(cwd, ["rev-parse", name]);
const trackingRefs = (cwd: string) =>
  git(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/retired"]);
function expectBrokenFetch(result: Awaited<ReturnType<typeof runGit>>) {
  expect(result.code).toBe(128);
  expect(result.stderr).toContain(
    "which is in the commit graph file but not in the object database",
  );
}
async function expectRetainedTip() {
  expect(await fs.readFile(path.join(clone, ".git", "refs/heads/retained"), "utf8")).toBe(
    `${tip}\n`,
  );
}

let clone: string,
  source: string,
  linked: string,
  url: string,
  base: string,
  tip: string,
  retired: string;
beforeEach(async () => {
  const root = tempDirs.make("openclaw-broken-tip-");
  source = path.join(root, "source");
  clone = path.join(root, "clone");
  await git(root, ["init", "-b", "main", source]);
  await git(source, ["config", "user.name", "OpenClaw Test"]);
  await git(source, ["config", "user.email", "test@example.invalid"]);
  await git(source, ["config", "commit.gpgSign", "false"]);
  await git(source, ["config", "uploadpack.allowFilter", "true"]);
  await git(source, ["commit", "--allow-empty", "-m", "base"]);
  base = await ref(source, "HEAD");
  url = pathToFileURL(source).href;
  await git(root, ["clone", "--filter=blob:none", "--no-checkout", url, clone]);
  await git(source, ["commit", "--allow-empty", "-m", "remote tip"]);
  tip = await ref(source, "HEAD");
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
  linked = path.join(root, "linked");
  await git(clone, ["worktree", "add", "--detach", linked, tip]);
  const unborn = path.join(root, "unborn");
  await git(clone, ["worktree", "add", "--detach", unborn, base]);
  await git(unborn, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
  await git(source, ["commit", "--allow-empty", "-m", "retired remote tip"]);
  retired = await ref(source, "HEAD");
  await copyCommit(retired);
  await git(clone, ["update-ref", "refs/remotes/origin/retired", retired]);
  await git(source, ["update-ref", "refs/heads/main", tip]);
  await git(clone, ["commit-graph", "write", "--reachable"]);
  for (const oid of [tip, retired]) {
    await fs.unlink(path.join(objects, oid.slice(0, 2), oid.slice(2)));
  }
});

afterEach(() => vi.restoreAllMocks());

it("keeps a dry-run fetch read-only even when the clone needs repair", async () => {
  const fetched = await fetch("--dry-run");
  expectBrokenFetch(fetched);
  expect(await fs.readFile(path.join(clone, ".git", "refs/remotes/origin/retired"), "utf8")).toBe(
    `${retired}\n`,
  );
  expect((await executeGitCommand(clone, ["cat-file", "-t", tip], { env })).code).not.toBe(0);
});

it.each(["worktree", "renamed project branch", "pinned project commit"] as const)(
  "repairs commit-graph-only tips through %s without removing local branches or detached HEADs",
  async (entry) => {
    if (entry === "renamed project branch") {
      await git(source, ["branch", "-m", "main", "renamed"]);
      await git(source, ["branch", "-D", "keep"]);
    }
    expectBrokenFetch(await executeGitCommand(clone, fetchArgs, { env }));
    if (entry === "worktree") {
      // The live entry point inherits this variable from its process environment.
      vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
      try {
        expect(await resolveWorktreeBase(clone)).toMatchObject({
          commit: tip,
          fetchSucceeded: true,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    } else if (entry === "renamed project branch") {
      await refreshProjectCheckout({ target: clone, url }, { env });
      expect(await ref(clone, "refs/remotes/origin/renamed")).toBe(tip);
    } else {
      await ensureProjectCheckoutCommit({ target: clone, url, commit: tip }, { env });
    }
    expect(await git(clone, ["cat-file", "-t", tip])).toBe("commit");
    expect(await ref(clone, "refs/heads/main")).toBe(base);
    expect(await ref(clone, "refs/heads/retained")).toBe(tip);
    expect(await ref(linked, "HEAD")).toBe(tip);
    expect(await trackingRefs(clone)).toBe("");
    const after = await executeGitCommand(clone, fetchArgs, { env });
    expect(after.code).toBe(0);
  },
);

it("preserves custom tracking mappings while recovering missing tips", async () => {
  await git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(source, ["update-ref", "-d", "refs/heads/main"]);
  await git(clone, [
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/keep:refs/remotes/origin/main",
  ]);
  expect((await fetch()).code).toBe(0);
  expect(await ref(clone, "refs/remotes/origin/main")).toBe(tip);
  expect(await trackingRefs(clone)).toBe("refs/remotes/origin/retired");
});

it("repairs physical tips hidden by a replacement during project refresh", async () => {
  const replacement = `refs/replace/${tip}`;
  await git(clone, ["update-ref", replacement, base]);
  await refreshProjectCheckout({ target: clone, url }, { env });
  expect(await git(clone, ["--no-replace-objects", "cat-file", "-t", tip])).toBe("commit");
  expect(await ref(clone, replacement)).toBe(base);
});

it("preserves tags and tracking refs when the caller disables configured pruning", async () => {
  await git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(clone, ["tag", "local-only", base]);
  await git(clone, ["config", "fetch.prune", "true"]);
  await git(clone, ["config", "fetch.pruneTags", "true"]);
  expect((await fetch("--no-prune")).code).toBe(0);
  expect(await ref(clone, "refs/tags/local-only")).toBe(base);
  expect(await ref(clone, "refs/remotes/origin/retired")).toBe(retired);
});

it("does not treat an option value as permission to repair origin", async () => {
  await git(clone, ["remote", "add", "upstream", url]);
  await git(clone, ["config", "branch.main.remote", "upstream"]);
  await git(clone, ["config", "protocol.version", "2"]);
  const fetched = await runGit(clone, ["fetch", "--server-option", "origin"], { env });
  expectBrokenFetch(fetched);
  expect(await fs.readFile(path.join(clone, ".git", "refs/remotes/origin/retired"), "utf8")).toBe(
    `${retired}\n`,
  );
});

it("never follows an obsolete tracking ref replaced by a local-branch alias", async () => {
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
  await fetch();
  expect(replaced).toBe(true);
  await expectRetainedTip();
});

it("does not follow a tracking alias replaced immediately before project publication", async () => {
  expect((await fetch()).code).toBe(0);
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
  expect(await ref(clone, "refs/heads/retained")).toBe(tip);
});

it.each([
  ["local symbolic branch", "fetch"],
  ["worktree HEAD", "fetch"],
  ["local symbolic branch", "project refresh"],
  ["worktree HEAD", "project refresh"],
] as const)(
  "retains an obsolete tracking ref required by a %s during %s",
  async (owner, operation) => {
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
      expect((await fetch()).code).toBe(0);
    }
    expect(await ref(clone, "refs/remotes/origin/retired")).toBe(retired);
    expect(
      await git(owner === "local symbolic branch" ? clone : linked, [
        "rev-parse",
        owner === "local symbolic branch" ? "refs/heads/local-alias" : "HEAD",
      ]),
    ).toBe(retired);
  },
);

it.each(["unavailable", "uncertain"] as const)(
  "preserves local work when repair is %s",
  async (failure) => {
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
      const operation = fetch();
      if (failure === "uncertain") {
        await expect(operation).rejects.toBe(uncertain);
      } else {
        expect((await operation).code).toBe(128);
        expect(await logs.findText("Git repository repair failed")).toContain(
          "Local branches and worktree HEADs were preserved",
        );
      }
      await expectRetainedTip();
      expect(await ref(linked, "HEAD")).toBe(tip);
    } finally {
      logs.cleanup();
    }
  },
);

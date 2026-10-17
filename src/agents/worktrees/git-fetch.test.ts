import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
const config = (cwd: string, key: string, value: string) =>
  git(cwd, ["config", "--replace-all", key, value]);
const symbolic = (cwd: string, name: string, target: string) =>
  git(cwd, ["symbolic-ref", name, target]);
const rawRef = (name: string) => fs.readFile(path.join(clone, ".git", name), "utf8");
const refresh = () => refreshProjectCheckout({ target: clone, url }, { env });
const trackingRefs = (cwd: string) =>
  git(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/retired"]);
function expectBrokenFetch(result: Awaited<ReturnType<typeof runGit>>) {
  expect(result.code).toBe(128);
  expect(result.stderr).toContain(
    "which is in the commit graph file but not in the object database",
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
  vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
  const root = tempDirs.make("openclaw-broken-tip-");
  source = path.join(root, "source");
  clone = path.join(root, "clone");
  await git(root, ["init", "-b", "main", source]);
  await config(source, "user.name", "OpenClaw Test");
  await config(source, "user.email", "test@example.invalid");
  await config(source, "commit.gpgSign", "false");
  await config(source, "uploadpack.allowFilter", "true");
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
  await symbolic(unborn, "HEAD", "refs/heads/unborn");
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["dry-run", "option value"])("does not repair origin for %s", async (mode) => {
  if (mode === "option value") {
    await git(clone, ["remote", "add", "upstream", url]);
    await config(clone, "branch.main.remote", "upstream");
    await config(clone, "protocol.version", "2");
  }
  expectBrokenFetch(
    mode === "dry-run"
      ? await fetch("--dry-run")
      : await runGit(clone, ["fetch", "--server-option", "origin"], { env }),
  );
  expect(await rawRef("refs/remotes/origin/retired")).toBe(`${retired}\n`);
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
      expect(await resolveWorktreeBase(clone)).toMatchObject({ commit: tip, fetchSucceeded: true });
    } else if (entry === "renamed project branch") {
      await refresh();
      expect(await ref(clone, "refs/remotes/origin/renamed")).toBe(tip);
    } else {
      await ensureProjectCheckoutCommit({ target: clone, url, commit: tip }, { env });
    }
    expect(await git(clone, ["cat-file", "-t", tip])).toBe("commit");
    expect(await ref(clone, "refs/heads/main")).toBe(base);
    expect(await ref(clone, "refs/heads/retained")).toBe(tip);
    expect(await ref(linked, "HEAD")).toBe(tip);
    expect(await trackingRefs(clone)).toBe("");
    expect((await executeGitCommand(clone, fetchArgs, { env })).code).toBe(0);
  },
);

it("preserves custom tracking mappings while recovering missing tips", async () => {
  await config(source, "uploadpack.allowAnySHA1InWant", "true");
  await git(source, ["update-ref", "-d", "refs/heads/main"]);
  await config(clone, "remote.origin.fetch", "+refs/heads/keep:refs/remotes/origin/main");
  expect((await fetch()).code).toBe(0);
  expect(await ref(clone, "refs/remotes/origin/main")).toBe(tip);
  expect(await trackingRefs(clone)).toBe("refs/remotes/origin/retired");
});

it("repairs physical tips hidden by a replacement during project refresh", async () => {
  const replacement = `refs/replace/${tip}`;
  await git(clone, ["update-ref", replacement, base]);
  await refresh();
  expect(await git(clone, ["--no-replace-objects", "cat-file", "-t", tip])).toBe("commit");
  expect(await ref(clone, replacement)).toBe(base);
});

it("preserves tags and tracking refs when the caller disables configured pruning", async () => {
  await config(source, "uploadpack.allowAnySHA1InWant", "true");
  await git(clone, ["tag", "local-only", base]);
  await config(clone, "fetch.prune", "true");
  await config(clone, "fetch.pruneTags", "true");
  expect((await fetch("--no-prune")).code).toBe(0);
  expect(await ref(clone, "refs/tags/local-only")).toBe(base);
  expect(await ref(clone, "refs/remotes/origin/retired")).toBe(retired);
});

it.each(["prune", "publication"])("preserves local branches at %s", async (phase) => {
  if (phase === "publication") {
    expect((await fetch()).code).toBe(0);
  }
  const replacement = "refs/remotes/origin/retired2";
  await fs.writeFile(path.join(clone, ".git", replacement), `${tip}\n`);
  const run = processExec.runCommandWithTimeout;
  let replaced = false;
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    const result = phase === "publication" ? await run(argv, options) : undefined;
    const matches =
      phase === "prune"
        ? argv.includes("update-ref") && argv.includes("--stdin")
        : argv.includes("for-each-ref") && argv[argv.indexOf("-C") + 1] !== clone;
    if (!replaced && matches) {
      replaced = true;
      await symbolic(clone, replacement, "refs/heads/retained");
    }
    return result ?? run(argv, options);
  });
  if (phase === "publication") {
    await refresh();
  } else {
    await fetch();
  }
  expect(replaced).toBe(true);
  expect(await ref(clone, "refs/heads/retained")).toBe(tip);
  expect(await rawRef("refs/heads/retained")).toBe(`${tip}\n`);
});

it.each([
  ["local symbolic branch", "fetch"],
  ["worktree HEAD", "fetch"],
  ["local symbolic branch", "project refresh"],
  ["worktree HEAD", "project refresh"],
] as const)("retains tracking refs for %s during %s", async (owner, operation) => {
  const local = owner === "local symbolic branch";
  await config(source, "uploadpack.allowAnySHA1InWant", "true");
  if (local) {
    await symbolic(clone, "refs/remotes/origin/alias", "refs/remotes/origin/retired");
    await symbolic(clone, "refs/heads/local-alias", "refs/remotes/origin/alias");
  } else {
    await symbolic(linked, "HEAD", "refs/remotes/origin/retired");
  }
  if (operation === "project refresh") {
    await refresh();
  } else {
    expect((await fetch()).code).toBe(0);
  }
  expect(await ref(clone, "refs/remotes/origin/retired")).toBe(retired);
  const ownerRef = local ? "refs/heads/local-alias" : "HEAD";
  expect(await ref(local ? clone : linked, ownerRef)).toBe(retired);
});

it.each(["unavailable", "uncertain"])("preserves local work on %s repair", async (failure) => {
  const logs = createWarnLogCapture("missing-tip-repair");
  onTestFinished(() => logs.cleanup());
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
  const operation = fetch();
  if (failure === "uncertain") {
    await expect(operation).rejects.toBe(uncertain);
  } else {
    expect((await operation).code).toBe(128);
    expect(await logs.findText("Git repository repair failed")).toContain(
      "Local branches and worktree HEADs were preserved",
    );
  }
  expect(await rawRef("refs/heads/retained")).toBe(`${tip}\n`);
  expect(await ref(linked, "HEAD")).toBe(tip);
});

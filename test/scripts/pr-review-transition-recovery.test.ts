import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createIndependentPrFixtureEnv } from "./pr-wrapper.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const helper = resolve("scripts/pr-lib/review-transition-recovery.mjs");
const validator = resolve("scripts/pr-lib/review-transition-state.mjs");
const lockOwner = resolve("scripts/pr-lib/operation-lock.sh");
const worktreeOwner = resolve("scripts/pr-lib/worktree.sh");
const commonOwner = resolve("scripts/pr-lib/common.sh");
const wrapper = readFileSync("scripts/pr", "utf8");
const inline = wrapper.split("<<'EOF_WRAPPER_GIT'\n")[1]?.split("\nEOF_WRAPPER_GIT")[0];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function runOwnedGroup(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await once(child, "close");
  return { status: child.exitCode, stdout, stderr };
}

function fixture(content = "") {
  const root = realpathSync(temps.make("pr-review-transition-recovery-"));
  const env: NodeJS.ProcessEnv = {
    ...createIndependentPrFixtureEnv(),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd = root) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return r.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Recovery Fixture"]);
  git(["config", "user.email", "recovery@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.hooksPath", "/dev/null"]);
  git(["remote", "add", "origin", root]);
  writeFileSync(join(root, "tracked.txt"), "source bytes\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const source = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", source]);
  writeFileSync(join(root, "tracked.txt"), "target bytes\n");
  git(["commit", "-qam", "target"]);
  const target = git(["rev-parse", "HEAD"]);
  // The production owner creates the binding; no handcrafted receipt or lock.
  const admitted = spawnSync(
    process.execPath,
    ["--input-type=module", "-", "git", "workflow-admit", root, "42", source, ""],
    { env, input: inline, encoding: "utf8" },
  );
  expect(admitted.status, admitted.stderr).toBe(0);
  const binding = admitted.stdout.trim();
  const worktree = join(root, ".worktrees/pr-42");
  git(["worktree", "add", "-qb", "temp/pr-42", worktree, source]);
  mkdirSync(join(worktree, ".local"));
  const journal = join(worktree, ".local/review-transition.json");
  writeFileSync(
    journal,
    JSON.stringify({ version: 1, pr: 42, source, target, mode: "detached", branch: null }),
  );
  writeFileSync(join(worktree, "tracked.txt"), content);
  const index = git(["rev-parse", "--git-path", "index"], worktree);
  const plan = {
    version: 1,
    pr: 42,
    binding,
    head: source,
    headRef: "refs/heads/temp/pr-42",
    journalSha256: sha(readFileSync(journal)),
    indexSha256: sha(readFileSync(index)),
    path: "tracked.txt",
    workingEntry: "100644 " + git(["hash-object", "--no-filters", "tracked.txt"], worktree),
    reason: "Explicitly preserve this interrupted checkout's unknown file.",
  };
  const planPath = join(worktree, ".local/selected-recovery.json");
  const sealPlan = () => {
    const bytes = Buffer.from(JSON.stringify(plan));
    writeFileSync(planPath, bytes);
    return sha(bytes);
  };
  const seal = sealPlan();
  const snapshot = () => ({
    head: git(["rev-parse", "HEAD"], worktree),
    binding: git(["rev-parse", "refs/openclaw/pr-workflow-bindings/42"]),
    index: sha(readFileSync(index)),
    journal: readFileSync(journal),
    file: readFileSync(join(worktree, "tracked.txt")),
  });
  const run = (selectedSeal = seal, lostLock = false, preload = "") =>
    runOwnedGroup(
      bash,
      [
        "-c",
        [
          "set -eu",
          'source "$1"',
          'fixture_root="$2"',
          'repo_root() { printf "%s\\n" "$fixture_root"; }',
          'pr_git() { command git "$@"; }',
          "acquire_pr_operation_lock 42",
          'lock_ref="$PR_OPERATION_LOCK_REF"',
          'lock_oid="$PR_OPERATION_LOCK_OWNER_OID"',
          "trap release_pr_operation_lock EXIT",
          'cd "$3"',
          ...(lostLock ? ["release_pr_operation_lock"] : []),
          'node "$4" 42 "$5" "$6" "$fixture_root" "$lock_ref" "$lock_oid" "$7" "$8"',
        ].join("\n"),
        "recovery-fixture",
        lockOwner,
        root,
        worktree,
        helper,
        planPath,
        selectedSeal,
        source,
        binding,
      ],
      preload
        ? {
            ...env,
            NODE_OPTIONS: (env.NODE_OPTIONS || "") + " --require=" + JSON.stringify(preload),
          }
        : env,
    );
  const validate = () =>
    spawnSync(process.execPath, [validator, source, target], {
      cwd: worktree,
      env,
      encoding: "utf8",
    });
  const replay = () =>
    spawnSync(
      bash,
      [
        "-c",
        'set -eu; source "$1"; source "$2"; canonical_repo_root="$3"; pr_git() { command git "$@"; }; cd "$4"; recover_review_transition 42',
        "replay-fixture",
        commonOwner,
        worktreeOwner,
        root,
        worktree,
      ],
      { env, encoding: "utf8" },
    );
  return {
    root,
    worktree,
    source,
    target,
    binding,
    index,
    journal,
    plan,
    planPath,
    seal,
    sealPlan,
    git,
    snapshot,
    run,
    validate,
    replay,
  };
}

describe.skipIf(process.platform === "win32")("explicit review-transition file salvage", () => {
  it.each(["", "unknown operator work\n"])(
    "preserves selected bytes %j, leaves authority intact, and permits ordinary replay",
    async (content) => {
      const f = fixture(content);
      expect(f.validate().status).toBe(1);
      const before = f.snapshot();
      const repaired = await f.run();
      expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
      const backup = join(f.worktree, ".local/review-transition-recovery." + f.seal);
      expect(readFileSync(join(backup, "worktree.before"), "utf8")).toBe(content);
      expect(readFileSync(join(backup, "index.before"))).toEqual(readFileSync(f.index));
      expect(readFileSync(join(backup, "journal.before"))).toEqual(before.journal);
      expect(f.snapshot()).toEqual({ ...before, file: Buffer.from("source bytes\n") });
      expect(f.validate().status).toBe(0);
      const inode = statSync(join(f.worktree, "tracked.txt")).ino;
      const reconciled = await f.run();
      expect(reconciled.status, reconciled.stdout + reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain("already_repaired");
      expect(statSync(join(f.worktree, "tracked.txt")).ino).toBe(inode);
      const replay = f.replay();
      expect(replay.status, replay.stdout + replay.stderr).toBe(0);
      expect(f.git(["rev-parse", "HEAD"], f.worktree)).toBe(f.target);
      expect(readFileSync(join(f.worktree, "tracked.txt"), "utf8")).toBe("target bytes\n");
      expect(f.git(["rev-parse", "refs/openclaw/pr-workflow-bindings/42"])).toBe(f.binding);
      expect(readFileSync(join(backup, "worktree.before"), "utf8")).toBe(content);
    },
  );

  it.each([
    "plan seal",
    "file",
    "journal",
    "index",
    "head",
    "binding",
    "symbolic binding",
    "lost lock",
    "path",
  ])("refuses changed %s without replacing the selected working file", async (fault) => {
    const f = fixture("preserve this\n");
    if (fault === "file") {
      writeFileSync(join(f.worktree, "tracked.txt"), "newer user edit\n");
    }
    if (fault === "journal") {
      writeFileSync(f.journal, readFileSync(f.journal, "utf8") + "\n");
    }
    if (fault === "index") {
      f.git(["update-index", "--assume-unchanged", "tracked.txt"], f.worktree);
    }
    if (fault === "head") {
      f.git(["checkout", "--detach", f.source], f.worktree);
    }
    if (fault === "binding") {
      f.git(["update-ref", "refs/openclaw/pr-workflow-bindings/42", f.source]);
    }
    if (fault === "symbolic binding") {
      f.git(["update-ref", "refs/other/binding", f.binding]);
      f.git(["symbolic-ref", "refs/openclaw/pr-workflow-bindings/42", "refs/other/binding"]);
    }
    let seal = f.seal;
    if (fault === "path") {
      f.plan.path = "../tracked.txt";
      seal = f.sealPlan();
    }
    const before = f.snapshot();
    const result = await f.run(
      fault === "plan seal" ? "0".repeat(64) : seal,
      fault === "lost lock",
    );
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    const message =
      fault === "plan seal"
        ? "Recovery plan seal differs"
        : fault === "file"
          ? "Selected working file differs"
          : fault === "journal" || fault === "index"
            ? "Recovery journal or index differs"
            : fault === "lost lock"
              ? "native PR operation lock"
              : fault === "path"
                ? "normal tracked file path"
                : "custody changed";
    expect(result.stderr).toContain(message);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(["before", "after"])(
    "reconciles interruption %s atomic replacement from the retained preimage",
    async (phase) => {
      const f = fixture("unknown work\n");
      const preload = join(f.root, "replacement-fault.cjs");
      writeFileSync(
        preload,
        'const fs = require("node:fs"); const rename = fs.renameSync; fs.renameSync = (...args) => { if (String(args[0]).endsWith("/replacement")) { ' +
          (phase === "after" ? "rename(...args); " : "") +
          'throw new Error("fixture replacement interruption"); } return rename(...args); };',
      );
      const before = f.snapshot();
      const interrupted = await f.run(f.seal, false, preload);
      expect(interrupted.status).not.toBe(0);
      expect(interrupted.stderr).toContain("fixture replacement interruption");
      expect(f.snapshot()).toEqual({
        ...before,
        file: Buffer.from(phase === "after" ? "source bytes\n" : "unknown work\n"),
      });
      const reconciled = await f.run();
      expect(reconciled.status, reconciled.stdout + reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain(phase === "after" ? "already_repaired" : '"repaired"');
      expect(
        readFileSync(
          join(f.worktree, ".local/review-transition-recovery." + f.seal, "worktree.before"),
          "utf8",
        ),
      ).toBe("unknown work\n");
      expect(f.validate().status).toBe(0);
    },
  );

  it("preserves foreign state outside the explicitly selected path", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "foreign.txt"), "unlisted work\n");
    const result = await f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.validate().status).toBe(1);
    expect(readFileSync(join(f.worktree, "foreign.txt"), "utf8")).toBe("unlisted work\n");
  });

  it("refuses a symlinked backup and does not write outside the reserved namespace", async () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.worktree, ".local/review-transition-recovery." + f.seal));
    const before = f.snapshot();
    const result = await f.run();
    expect(result.status).not.toBe(0);
    expect(f.snapshot()).toEqual(before);
  });
});

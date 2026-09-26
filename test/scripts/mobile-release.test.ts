import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const script = path.join(process.cwd(), "scripts/mobile-release.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadataPath = "apps/ios/CHANGELOG.md";
const uploadRef = "refs/openclaw/mobile-releases/ios/2026.9.2-8";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function fixture(prepareAndUpload = false) {
  const directory = tempDirs.make("openclaw-mobile-release-");
  const remote = path.join(directory, "origin.git");
  const root = path.join(directory, "checkout");
  const recovery = path.join(directory, "recovery");
  const bin = path.join(directory, "bin");
  const ghState = path.join(directory, "github.json");
  const ghLog = path.join(directory, "github-calls.jsonl");
  const uploadAudit = path.join(directory, "upload.json");
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "clone", remote, root);
  git(root, "config", "user.name", "Release Fixture");
  git(root, "config", "user.email", "release@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  write(root, metadataPath, "# iOS releases\n\n## Unreleased\n\nPending release notes.\n");
  write(root, "README.md", "Original application source.\n");
  write(
    root,
    "scripts/ios-release-plan.sh",
    'echo "Unexpected Fastlane invocation" >&2\nexit 99\n',
  );
  if (prepareAndUpload) {
    write(root, ".gitignore", "node_modules\n");
    write(root, "package.json", '{"name":"mobile-release-fixture","type":"module"}\n');
    write(root, "node_modules/tsx/package.json", '{"name":"tsx","exports":"./index.mjs"}\n');
    write(root, "node_modules/tsx/index.mjs", "export {};\n");
    write(
      root,
      "scripts/ios-release-plan.sh",
      `echo '{"gatewayVersion":"2026.9.2","appStoreRevision":0,"buildNumber":8}'\n`,
    );
    write(
      root,
      "scripts/ios-release-cut.ts",
      `import fs from "node:fs";
const plan = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--plan") + 1], "utf8"));
if (plan.gatewayVersion !== "2026.9.2" || plan.buildNumber !== 8) throw new Error("Unexpected store plan");
fs.writeFileSync("apps/ios/CHANGELOG.md", "Prepared store metadata.\\n");
`,
    );
    write(root, "scripts/ios-release-upload.sh", "exec node scripts/fixture-upload.mjs\n");
    write(
      root,
      "scripts/fixture-upload.mjs",
      `import fs from "node:fs";
import { execFileSync } from "node:child_process";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const audit = {
  sha,
  stampedSha: process.env.GIT_COMMIT,
  status: git("status", "--porcelain", "--untracked-files=all"),
  remoteMain: git("ls-remote", "origin", "refs/heads/main").split(/\\s+/)[0],
  metadata: fs.readFileSync("apps/ios/CHANGELOG.md", "utf8")
};
fs.writeFileSync(process.env.FIXTURE_UPLOAD_AUDIT, JSON.stringify(audit));
if (process.env.FIXTURE_UPLOAD_FAIL === "1") throw new Error("Synthetic store upload refused");
git("push", "origin", sha + ":${uploadRef}");
console.log("Synthetic store upload accepted");
`,
    );
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial source");
  git(root, "push", "origin", "main");
  const base = git(root, "rev-parse", "HEAD");
  fs.mkdirSync(recovery);
  fs.mkdirSync(bin);
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const remote = process.env.FIXTURE_REMOTE;
const statePath = process.env.FIXTURE_GH_STATE;
fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(args) + "\\n");
const git = (...argv) => execFileSync("git", ["--git-dir", remote, ...argv], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "GitHub Fixture", GIT_AUTHOR_EMAIL: "github@example.invalid", GIT_COMMITTER_NAME: "GitHub Fixture", GIT_COMMITTER_EMAIL: "github@example.invalid" }
}).trim();
const value = (flag) => args[args.indexOf(flag) + 1];
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ nameWithOwner: "fixture/openclaw" }));
} else if (args[0] === "pr" && args[1] === "list") {
  console.log(JSON.stringify(state ? [state] : []));
} else if (args[0] === "pr" && args[1] === "create") {
  if (state) throw new Error("Duplicate PR creation");
  const branch = value("--head");
  state = { number: 1, state: "OPEN", branch, headRefOid: git("rev-parse", "refs/heads/" + branch), url: "https://github.com/fixture/openclaw/pull/1" };
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(state.url);
} else if (args[0] === "pr" && args[1] === "merge") {
  if (!state || state.state !== "OPEN") throw new Error("Duplicate or missing PR merge");
  if (!args.includes("--squash") || value("--match-head-commit") !== state.headRefOid) throw new Error("Expected exact-head squash merge");
  const parent = git("rev-parse", "refs/heads/main");
  if (git("rev-parse", state.headRefOid + "^") !== parent) throw new Error("Finalizer did not prepare metadata on current main");
  const tree = git("rev-parse", state.headRefOid + "^{tree}");
  if (!args.includes("--body-file")) throw new Error("Expected merge message body file");
  const body = fs.readFileSync(value("--body-file"), "utf8");
  const sha = git("commit-tree", tree, "-p", parent, "-m", value("--subject"), "-m", body);
  git("update-ref", "refs/heads/main", sha, parent);
  state.state = "MERGED";
  state.mergeCommit = { oid: sha };
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify(state));
} else {
  throw new Error("Unexpected gh command: " + args.join(" "));
}
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    FIXTURE_REMOTE: remote,
    FIXTURE_GH_STATE: ghState,
    FIXTURE_GH_LOG: ghLog,
    FIXTURE_UPLOAD_AUDIT: uploadAudit,
    GITHUB_ACTIONS: "false",
    GITHUB_REF: "",
    GITHUB_SHA: "",
    GITHUB_RUN_ATTEMPT: "",
    GITHUB_OUTPUT: path.join(directory, "github-output.txt"),
  };
  const invoke = (
    operation: "run" | "finalize",
    extra: string[] = [],
    overrides: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      [script, operation, "--platform", "ios", "--recovery-dir", recovery, ...extra],
      { cwd: root, env: { ...env, ...overrides }, encoding: "utf8" },
    );
  const calls = (): string[][] =>
    fs.existsSync(ghLog)
      ? fs
          .readFileSync(ghLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { directory, root, remote, recovery, base, invoke, calls, uploadAudit };
}

function prepare(f: ReturnType<typeof fixture>, unexpectedFile = false): string {
  git(f.root, "checkout", "--detach", f.base);
  write(f.root, metadataPath, "# iOS releases\n\n## 2026.9.20\n\nUploaded release notes.\n");
  if (unexpectedFile) {
    write(f.root, "README.md", "Unreviewed application change.\n");
  }
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Prepare store release\n\nMobile-Release-Platform: ios");
  const sha = git(f.root, "rev-parse", "HEAD");
  git(f.root, "bundle", "create", path.join(f.recovery, "release.bundle"), `${f.base}..HEAD`);
  git(f.root, "checkout", "main");
  return sha;
}

function advanceMain(f: ReturnType<typeof fixture>, conflict = false): string {
  git(f.root, "checkout", "-b", "advance-main", f.base);
  write(
    f.root,
    conflict ? metadataPath : "README.md",
    conflict ? "# Conflicting release history\n" : "Application source advanced after upload.\n",
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Advance main after store preparation");
  const sha = git(f.root, "rev-parse", "HEAD");
  git(f.root, "push", "origin", "HEAD:main");
  git(f.root, "checkout", "main");
  return sha;
}

describe("mobile release CLI", () => {
  it("commits complete preparation before upload and defers all main changes until finalization", () => {
    const f = fixture(true);
    const advanced = advanceMain(f);
    const stale = f.invoke("run", ["--defer-finalization"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Local main differs from origin/main");
    expect(fs.existsSync(f.uploadAudit)).toBe(false);
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(false);
    const ci = {
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: f.base,
    };
    const result = f.invoke("run", ["--defer-finalization"], ci);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Synthetic store upload accepted");
    const audit = JSON.parse(fs.readFileSync(f.uploadAudit, "utf8"));
    expect(audit).toMatchObject({
      stampedSha: audit.sha,
      status: "",
      remoteMain: advanced,
      metadata: "Prepared store metadata.\n",
    });
    expect(audit.sha).not.toBe(f.base);
    expect(git(f.remote, "rev-parse", "main")).toBe(advanced);
    expect(git(f.remote, "rev-parse", uploadRef)).toBe(audit.sha);
    expect(git(f.remote, "rev-parse", `${audit.sha}^`)).toBe(f.base);
    expect(git(f.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", audit.sha)).toBe(
      metadataPath,
    );
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(false);
    expect(fs.existsSync(path.join(f.recovery, "release.bundle"))).toBe(true);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
    expect(f.calls()).toEqual([]);

    const failedRecovery = path.join(f.directory, "failed-recovery");
    const failed = f.invoke("run", ["--recovery-dir", failedRecovery], {
      ...ci,
      FIXTURE_UPLOAD_FAIL: "1",
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Synthetic store upload refused");
    expect(fs.existsSync(path.join(failedRecovery, "source"))).toBe(true);
    expect(fs.existsSync(path.join(failedRecovery, "release.bundle"))).toBe(true);
    expect(git(f.remote, "rev-parse", "main")).toBe(advanced);
    expect(f.calls()).toEqual([]);
  });

  it("requires upload proof, reapplies metadata to advanced main, and finalizes only once", () => {
    const f = fixture();
    const source = prepare(f);
    const missing = f.invoke("finalize");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no successful upload record");
    expect(f.calls()).toEqual([]);
    expect(git(f.remote, "rev-parse", "main")).toBe(f.base);

    git(f.root, "push", "origin", `${source}:${uploadRef}`);
    const advanced = advanceMain(f);
    fs.unlinkSync(path.join(f.recovery, "release.bundle"));
    const result = f.invoke("finalize", ["--source-sha", source]);
    expect(result.status, result.stderr).toBe(0);
    const landed = git(f.remote, "rev-parse", "main");
    expect(git(f.remote, "rev-list", "--parents", "-n", "1", landed)).toBe(`${landed} ${advanced}`);
    expect(git(f.remote, "show", `${landed}:README.md`)).toBe(
      "Application source advanced after upload.",
    );
    expect(git(f.remote, "show", `${landed}:${metadataPath}`)).toContain("Uploaded release notes.");
    expect(git(f.remote, "show", "-s", "--format=%B", landed)).toContain(
      `Mobile-Release-Source: ${source}`,
    );
    expect(git(f.remote, "rev-parse", uploadRef)).toBe(source);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
    expect(fs.existsSync(path.join(f.recovery, "finalize"))).toBe(false);
    const mutations = f.calls().filter((args) => args[1] === "create" || args[1] === "merge");
    expect(mutations.map((args) => args[1])).toEqual(["create", "merge"]);

    const retry = f.invoke("finalize", ["--source-sha", source]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain("already recorded on main");
    expect(git(f.remote, "rev-parse", "main")).toBe(landed);
    expect(f.calls().filter((args) => args[1] === "create" || args[1] === "merge")).toEqual(
      mutations,
    );
  });

  it("refuses preparation commits that include application changes before creating a PR", () => {
    const f = fixture();
    const source = prepare(f, true);
    git(f.root, "push", "origin", `${source}:${uploadRef}`);
    const result = f.invoke("finalize");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected file: README.md");
    expect(f.calls()).toEqual([]);
    expect(git(f.remote, "rev-parse", "main")).toBe(f.base);
  });

  it("retains a real metadata conflict and finalizes its explicit resolution on retry", () => {
    const f = fixture();
    const source = prepare(f);
    git(f.root, "push", "origin", `${source}:${uploadRef}`);
    const advanced = advanceMain(f, true);
    const result = f.invoke("finalize");
    expect(result.status).toBe(1);
    const worktree = path.join(f.recovery, "finalize");
    expect(fs.existsSync(worktree)).toBe(true);
    expect(git(worktree, "rev-parse", "CHERRY_PICK_HEAD")).toBe(source);
    expect(git(worktree, "diff", "--name-only", "--diff-filter=U")).toBe(metadataPath);
    expect(f.calls().some((args) => args[1] === "create" || args[1] === "merge")).toBe(false);
    expect(git(f.remote, "rev-parse", "main")).toBe(advanced);
    expect(git(f.remote, "rev-parse", uploadRef)).toBe(source);

    write(worktree, metadataPath, "# Conflicting release history\n\nUploaded release notes.\n");
    git(worktree, "add", metadataPath);
    git(worktree, "-c", "core.editor=true", "cherry-pick", "--continue");
    git(
      worktree,
      "commit",
      "--amend",
      "-m",
      `Resolve release metadata\n\nMobile-Release-Platform: ios\nMobile-Release-Source: ${source}`,
    );
    const retry = f.invoke("finalize");
    expect(retry.status, retry.stderr).toBe(0);
    const landed = git(f.remote, "rev-parse", "main");
    expect(git(f.remote, "rev-list", "--parents", "-n", "1", landed)).toBe(`${landed} ${advanced}`);
    expect(git(f.remote, "show", `${landed}:${metadataPath}`)).toBe(
      "# Conflicting release history\n\nUploaded release notes.",
    );
    expect(git(f.remote, "rev-parse", uploadRef)).toBe(source);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(
      f
        .calls()
        .filter((args) => args[1] === "create" || args[1] === "merge")
        .map((args) => args[1]),
    ).toEqual(["create", "merge"]);
  });

  it("rejects dirty and non-main checkouts before creating a release worktree or calling Fastlane", () => {
    const f = fixture();
    write(f.root, "uncommitted.txt", "Unrelated local work.\n");
    const dirty = f.invoke("run", ["--defer-finalization"]);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("require a clean checkout");
    fs.unlinkSync(path.join(f.root, "uncommitted.txt"));
    git(f.root, "checkout", "-b", "feature");
    const branch = f.invoke("run", ["--defer-finalization"]);
    expect(branch.status).toBe(1);
    expect(branch.stderr).toContain("Start a release from a clean, current main");
    expect(`${dirty.stderr}${branch.stderr}`).not.toContain("Unexpected Fastlane invocation");
    expect(fs.existsSync(path.join(f.recovery, "source"))).toBe(false);
    expect(git(f.root, "branch", "--show-current")).toBe("feature");
    expect(f.calls()).toEqual([]);
  });
});

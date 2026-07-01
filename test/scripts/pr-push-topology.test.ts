// PR push topology tests exercise real temporary Git repositories and refs.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const repoRoot = process.cwd();
const pushScript = path.join(repoRoot, "scripts", "pr-lib", "push.sh");
const commonScript = path.join(repoRoot, "scripts", "pr-lib", "common.sh");
const prepareScript = path.join(repoRoot, "scripts", "pr-lib", "prepare-core.sh");
const { createTempDir } = createScriptTestHarness();
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

interface TopologyFixture {
  base: string;
  broken: string;
  lease: string;
  mainline: string;
  prepared: string;
  preparedTree: string;
  remote: string;
  repo: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

function runBash(cwd: string, script: string, env: Record<string, string> = {}) {
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      ...gitEnv,
      ...env,
      COMMON_SCRIPT: commonScript,
      PREPARE_SCRIPT: prepareScript,
      PUSH_SCRIPT: pushScript,
    },
  });
  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}

function commitTree(repo: string, tree: string, parent: string, message: string): string {
  return git(repo, "commit-tree", tree, "-p", parent, "-m", message);
}

function createTopologyFixture(): TopologyFixture {
  const root = createTempDir("openclaw-pr-topology-");
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "maintainer@example.com");
  git(repo, "config", "user.name", "Maintainer");

  writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-qb", "topic");
  writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-qm", "feature");
  const lease = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-qB", "main", base);
  git(repo, "commit", "--allow-empty", "-qm", "mainline");
  const mainline = git(repo, "rev-parse", "HEAD");
  const preparedTree = git(repo, "rev-parse", `${lease}^{tree}`);
  const prepared = commitTree(repo, preparedTree, mainline, "prepared");
  const broken = commitTree(repo, preparedTree, lease, "graphql publication");

  mkdirSync(remote);
  git(remote, "init", "--bare", "-q");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "remote", "add", "prhead", remote);
  git(repo, "push", "-q", "origin", `${mainline}:refs/heads/main`);
  git(repo, "push", "-q", "prhead", `${broken}:refs/heads/topic`);
  git(repo, "checkout", "-q", "--detach", prepared);

  return { base, broken, lease, mainline, prepared, preparedTree, remote, repo };
}

function runRepair(fixture: TopologyFixture, lease = fixture.broken, tree = fixture.preparedTree) {
  return runBash(
    fixture.repo,
    `gh() { printf called > "$GRAPHQL_MARKER"; return 99; }
    source "$PUSH_SCRIPT"
    repair_synced_ancestry_ref topic "$LEASE" "$PREPARED" "$BASE" "$TREE"`,
    {
      BASE: fixture.mainline,
      GRAPHQL_MARKER: path.join(fixture.repo, "graphql-called"),
      LEASE: lease,
      PREPARED: fixture.prepared,
      TREE: tree,
    },
  );
}

describe("PR push topology", () => {
  it("allows descendant GraphQL publication", () => {
    const fixture = createTopologyFixture();
    const descendant = commitTree(fixture.repo, fixture.preparedTree, fixture.broken, "descendant");
    git(fixture.repo, "checkout", "-q", "--detach", descendant);
    const marker = path.join(fixture.repo, "graphql-called");

    const result = runBash(
      fixture.repo,
      `gh() {
        printf called > "$MARKER"
        printf '{"data":{"createCommitOnBranch":{"commit":{"oid":"%s"}}}}\\n' "$PREPARED"
      }
      source "$PUSH_SCRIPT"
      graphql_push_to_fork owner/repo topic "$LEASE"`,
      { LEASE: fixture.broken, MARKER: marker, PREPARED: descendant },
    );

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses non-descendant GraphQL publication before mutation", () => {
    const fixture = createTopologyFixture();
    const marker = path.join(fixture.repo, "graphql-called");

    const result = runBash(
      fixture.repo,
      `gh() { printf called > "$MARKER"; }
      source "$PUSH_SCRIPT"
      graphql_push_to_fork owner/repo topic "$LEASE"`,
      { LEASE: fixture.broken, MARKER: marker },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("GraphQL push refused before mutation");
    expect(existsSync(marker)).toBe(false);
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(fixture.broken);
  });

  it("refuses GraphQL publication that would drop a prepared mainline merge parent", () => {
    const fixture = createTopologyFixture();
    const merged = git(
      fixture.repo,
      "commit-tree",
      fixture.preparedTree,
      "-p",
      fixture.broken,
      "-p",
      fixture.mainline,
      "-m",
      "merged",
    );
    git(fixture.repo, "checkout", "-q", "--detach", merged);
    const marker = path.join(fixture.repo, "graphql-called");

    const result = runBash(
      fixture.repo,
      `gh() { printf called > "$MARKER"; }
      source "$PUSH_SCRIPT"
      graphql_push_to_fork owner/repo topic "$LEASE"`,
      { LEASE: fixture.broken, MARKER: marker },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("discard the prepared mainline merge-base");
    expect(existsSync(marker)).toBe(false);
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(fixture.broken);
  });

  it("keeps explicit git-mode rebased publication available", () => {
    const fixture = createTopologyFixture();

    const result = runBash(
      fixture.repo,
      'source "$PUSH_SCRIPT"; push_prep_head_once topic "$LEASE" "$PREPARED"',
      {
        LEASE: fixture.broken,
        OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH: "1",
        OPENCLAW_PR_PUSH_MODE: "git",
        PREPARED: fixture.prepared,
      },
    );

    expect(result.status).toBe(0);
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(fixture.prepared);
  });

  it("repairs only same-tree ancestry with a force-with-lease ref move", () => {
    const fixture = createTopologyFixture();

    const result = runRepair(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toContain(fixture.prepared);
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(fixture.prepared);
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic^{tree}")).toBe(fixture.preparedTree);
    expect(git(fixture.repo, "merge-base", fixture.mainline, fixture.prepared)).toBe(
      fixture.mainline,
    );
    expect(existsSync(path.join(fixture.repo, "graphql-called"))).toBe(false);
  });

  it("refuses ancestry repair after a lease mismatch", () => {
    const fixture = createTopologyFixture();
    const moved = commitTree(fixture.repo, fixture.preparedTree, fixture.broken, "remote moved");
    git(fixture.repo, "push", "-q", "--force", "prhead", `${moved}:refs/heads/topic`);

    const result = runRepair(fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("remote lease changed");
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(moved);
  });

  it("refuses ancestry repair when the remote tree differs", () => {
    const fixture = createTopologyFixture();
    const differentTree = git(fixture.repo, "rev-parse", `${fixture.mainline}^{tree}`);
    const different = commitTree(fixture.repo, differentTree, fixture.broken, "different tree");
    git(fixture.repo, "push", "-q", "--force", "prhead", `${different}:refs/heads/topic`);

    const result = runRepair(fixture, different);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("remote lease tree differs");
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(different);
  });

  it("does not publish when the force-with-lease dry run fails", () => {
    const fixture = createTopologyFixture();
    const binDir = path.join(fixture.repo, "fake-bin");
    const actualPushMarker = path.join(fixture.repo, "actual-push");
    mkdirSync(binDir);
    const fakeGit = path.join(binDir, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "push" ]; then
  case " $* " in
    *" --dry-run "*) exit 77 ;;
    *) printf called > "$ACTUAL_PUSH_MARKER" ;;
  esac
fi
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(fakeGit, 0o755);

    const result = runBash(
      fixture.repo,
      'source "$PUSH_SCRIPT"; repair_synced_ancestry_ref topic "$LEASE" "$PREPARED" "$BASE" "$TREE"',
      {
        ACTUAL_PUSH_MARKER: actualPushMarker,
        BASE: fixture.mainline,
        LEASE: fixture.broken,
        PATH: `${binDir}:${process.env.PATH}`,
        PREPARED: fixture.prepared,
        REAL_GIT: realGit,
        TREE: fixture.preparedTree,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("permission dry run failed");
    expect(existsSync(actualPushMarker)).toBe(false);
    expect(git(fixture.remote, "rev-parse", "refs/heads/topic")).toBe(fixture.broken);
  });

  it("requires exact published-head hosted gates after ancestry repair", () => {
    const fixture = createTopologyFixture();
    expect(runRepair(fixture).status).toBe(0);
    const localDir = path.join(fixture.repo, ".local");
    mkdirSync(localDir);
    writeFileSync(
      path.join(localDir, "prep-sync.env"),
      "PREP_SYNC_MODE=ancestry_repair\nPREP_SYNC_PUBLISHED_HEAD_SHA=\nPREP_SYNC_REQUIRES_HOSTED_GATES=1\n",
    );
    const activeSyncReentry = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; guard_active_prep_sync',
    );
    expect(activeSyncReentry.status).not.toBe(0);
    expect(activeSyncReentry.output).toContain("active sync artifact");

    writeFileSync(
      path.join(localDir, "prep-sync.env"),
      [
        `PREP_SYNC_PUBLISHED_HEAD_SHA=${fixture.prepared}`,
        "PREP_SYNC_REQUIRES_HOSTED_GATES=1",
        "PREP_SYNC_MODE=ancestry_repair",
      ].join("\n"),
    );

    const gateCheck =
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; require_exact_prepare_gates "$PREPARED"';
    const missing = runBash(fixture.repo, gateCheck, { PREPARED: fixture.prepared });
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain("Missing required artifact: .local/gates.env");

    const syncReentry = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; guard_active_prep_sync',
    );
    expect(syncReentry.status).not.toBe(0);
    expect(syncReentry.output).toContain("OPENCLAW_TESTBOX=1 scripts/pr prepare-run");

    writeFileSync(
      path.join(localDir, "gates.env"),
      [
        "GATES_MODE=hosted_exact_head",
        `LAST_VERIFIED_HEAD_SHA=${fixture.prepared}`,
        `HOSTED_GATES_HEAD_SHA=${fixture.prepared}`,
      ].join("\n"),
    );
    const exact = runBash(fixture.repo, gateCheck, { PREPARED: fixture.prepared });
    expect(exact.status).toBe(0);
  });

  it("resumes a published sync through exact hosted gates without prepare-init", () => {
    const fixture = createTopologyFixture();
    const localDir = path.join(fixture.repo, ".local");
    mkdirSync(localDir);
    writeFileSync(
      path.join(localDir, "prep-sync.env"),
      [
        `PREP_SYNC_PUBLISHED_HEAD_SHA=${fixture.prepared}`,
        "PREP_SYNC_REQUIRES_HOSTED_GATES=1",
        "PREP_SYNC_MODE=ancestry_repair",
      ].join("\n"),
    );

    const callerDir = path.join(fixture.repo, "caller");
    mkdirSync(callerDir);
    const result = runBash(
      callerDir,
      `source "$COMMON_SCRIPT"
      source "$PREPARE_SCRIPT"
      enter_worktree() { cd "$TARGET"; }
      prepare_init() { printf init; return 99; }
      prepare_gates() { printf gates; }
      prepare_push() { printf push; }
      prepare_run 1`,
      { OPENCLAW_TESTBOX: "1", TARGET: fixture.repo },
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("gatespush");
    expect(result.output).not.toContain("init");
  });

  it("detects case-folded tracked artifact aliases", () => {
    const fixture = createTopologyFixture();
    const artifact = path.join(fixture.repo, ".LOCAL", "PREP-SYNC.ENV");
    mkdirSync(path.dirname(artifact));
    writeFileSync(artifact, "tracked\n");
    git(fixture.repo, "add", "-f", ".LOCAL/PREP-SYNC.ENV");

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; artifact_path_is_tracked .local/prep-sync.env',
    );

    expect(result.status).toBe(0);
  });

  it("fails closed on legacy sync artifacts", () => {
    const fixture = createTopologyFixture();
    const localDir = path.join(fixture.repo, ".local");
    mkdirSync(localDir);
    writeFileSync(
      path.join(localDir, "prep-sync.env"),
      `PREP_SYNC_MAINLINE_BASE_SHA=${fixture.mainline}\nPREP_SYNC_TREE=${fixture.preparedTree}\n`,
    );

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; guard_active_prep_sync',
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("unsupported mode");
  });

  it("rejects tracked sync artifacts without executing them", () => {
    const fixture = createTopologyFixture();
    const localDir = path.join(fixture.repo, ".local");
    const marker = path.join(fixture.repo, "artifact-executed");
    mkdirSync(localDir);
    writeFileSync(
      path.join(localDir, "prep-sync.env"),
      `touch "$MARKER"\nPREP_SYNC_REQUIRES_HOSTED_GATES=1\n`,
    );
    git(fixture.repo, "add", "-f", ".local/prep-sync.env");

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; guard_active_prep_sync',
      { MARKER: marker },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Refusing untrusted local artifact");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to write a sync artifact through a broken symlink", () => {
    const fixture = createTopologyFixture();
    const localDir = path.join(fixture.repo, ".local");
    const target = path.join(fixture.repo, "outside-artifact");
    mkdirSync(localDir);
    symlinkSync(target, path.join(localDir, "prep-sync.env"));

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; write_prep_sync_artifact 1 topic "$LEASE" "$PREPARED" "$BASE"',
      {
        BASE: fixture.mainline,
        LEASE: fixture.broken,
        PREPARED: fixture.prepared,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Refusing untrusted local artifact destination");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to replace a sync artifact directory", () => {
    const fixture = createTopologyFixture();
    mkdirSync(path.join(fixture.repo, ".local", "prep-sync.env"), { recursive: true });

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; write_prep_sync_artifact 1 topic "$LEASE" "$PREPARED" "$BASE"',
      {
        BASE: fixture.mainline,
        LEASE: fixture.broken,
        PREPARED: fixture.prepared,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Refusing untrusted local artifact destination");
  });

  it("refuses a symlinked local artifact directory", () => {
    const fixture = createTopologyFixture();
    const outside = path.join(fixture.repo, "outside-local");
    mkdirSync(outside);
    symlinkSync(outside, path.join(fixture.repo, ".local"));

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; write_prep_sync_artifact 1 topic "$LEASE" "$PREPARED" "$BASE"',
      {
        BASE: fixture.mainline,
        LEASE: fixture.broken,
        PREPARED: fixture.prepared,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Refusing untrusted local artifact directory");
    expect(existsSync(path.join(outside, "prep-sync.env"))).toBe(false);
  });

  it("refuses a tracked but missing sync artifact destination", () => {
    const fixture = createTopologyFixture();
    const artifact = path.join(fixture.repo, ".local", "prep-sync.env");
    mkdirSync(path.dirname(artifact));
    writeFileSync(artifact, "tracked\n");
    git(fixture.repo, "add", "-f", ".local/prep-sync.env");
    rmSync(artifact);

    const result = runBash(
      fixture.repo,
      'source "$COMMON_SCRIPT"; source "$PREPARE_SCRIPT"; write_prep_sync_artifact 1 topic "$LEASE" "$PREPARED" "$BASE"',
      {
        BASE: fixture.mainline,
        LEASE: fixture.broken,
        PREPARED: fixture.prepared,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Refusing tracked local artifact destination");
    expect(existsSync(artifact)).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
} from "../../scripts/testbox-lease-freshness.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Testbox lease freshness", () => {
  it("records and reuses a lease with more than a buffer of source deletions", () => {
    const fixture = createLeaseFixture();
    const blob = fixture.git(["hash-object", "-w", "--stdin"], "");
    // Index-only files keep this real large-status fixture cheap to create and remove.
    const entries = Array.from(
      { length: 6_000 },
      (_, index) => `100644 ${blob}\t${String(index).padStart(4, "0")}-${"s".repeat(180)}.ts\n`,
    ).join("");
    fixture.git(["update-index", "--index-info"], entries);
    fixture.advanceBase();
    const outputPath = join(fixture.root, "status.txt");
    const output = openSync(outputPath, "w");
    try {
      execFileSync("git", ["-C", fixture.root, "status", "--porcelain=v1"], {
        stdio: ["ignore", output, "pipe"],
      });
    } finally {
      closeSync(output);
    }
    expect(statSync(outputPath).size).toBeGreaterThan(1024 * 1024);

    const prepared = fixture.allocate();
    expect(prepared).not.toBeNull();
    expect(fixture.reuse()?.current).toEqual(prepared?.current);
  });

  it.each([".github/workflows/custom-testbox.yml", ""])(
    "tracks preparation owners with workflow %j",
    (workflow) => {
      const fixture = createLeaseFixture();
      const owners = [
        "scripts/crabbox-wrapper.mjs",
        "scripts/crabbox-wrapper.mts",
        "scripts/crabbox-source-capsule.mts",
        "scripts/crabbox-source-receiver.mts",
        "scripts/testbox-lease-freshness.mts",
        ".github/actions/prepare-testbox-shell/action.yml",
        ".github/actions/prepare-testbox-shell/preserve-command-cwd.py",
        ...(workflow ? [workflow] : []),
      ];
      for (const owner of owners) {
        const file = join(fixture.root, owner);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "original\n");
      }
      fixture.git(["add", "."]);
      fixture.advanceBase();
      const args = workflow ? ["--blacksmith-workflow", workflow] : ["--blacksmith-workflow="];
      fixture.allocate(args);
      const prepare = () => fixture.reuse(args);
      writeFileSync(join(fixture.root, "unrelated-source.ts"), "source change\n");
      expect(() => prepare()).not.toThrow();
      for (const owner of owners) {
        const file = join(fixture.root, owner);
        writeFileSync(file, "changed executable owner\n");
        expect(() => prepare(), owner).toThrow("environmentDigest");
        writeFileSync(file, "original\n");
      }
    },
  );

  it.each(["baseSha", "dependencyDigest", "environmentDigest", "workflow", "job", "ref"])(
    "rejects recorded leases after %s changes",
    (field) => {
      const fixture = createLeaseFixture();
      const prepared = fixture.allocate();
      expect(prepared).not.toBeNull();
      const saved = readFileSync(fixture.statePath, "utf8");
      let args: string[] = [];
      if (field === "baseSha") {
        fixture.advanceBase();
      } else if (field === "dependencyDigest") {
        writeFileSync(join(fixture.root, "package.json"), '{"name":"changed"}\n');
      } else if (field === "environmentDigest") {
        writeFileSync(join(fixture.root, ".node-version"), "26.8.1\n");
      } else {
        args = [`--blacksmith-${field}`, "changed"];
      }
      expect(() => fixture.reuse(args, { OPENCLAW_TESTBOX_ALLOW_STALE: "1" })).toThrow(field);
      expect(readFileSync(fixture.statePath, "utf8")).toBe(saved);
    },
  );

  it("preserves failed-command allocation provenance across unchanged and changed source", () => {
    const fixture = createLeaseFixture();
    const allocation = fixture.prepare(["run", "--keep", "--", "false"]);
    recordTestboxLeaseFreshness(allocation, "tbx_fixture");
    const saved = readFileSync(fixture.statePath, "utf8");
    const originalStat = statSync(fixture.statePath);
    for (const change of ["unchanged", "empty commit", "source commit"]) {
      if (change === "source commit") {
        writeFileSync(join(fixture.root, "source.ts"), "export const value = 2;\n");
        fixture.git(["add", "source.ts"]);
      }
      const head = change === "unchanged" ? allocation?.current.headSha : fixture.advanceHead();
      const reused = fixture.reuse(["--", "pnpm", "test"]);
      expect(reused?.current).toEqual({ ...allocation?.current, headSha: head });
      expect(reused?.current.baseSha).toBe(allocation?.current.baseSha);
      expect(reused?.attribution.headSha).toBe(head);
      expect(reused?.attribution.commandKey).not.toBe(allocation?.attribution.commandKey);
      expect(() => reused?.assertCurrent()).not.toThrow();
      recordTestboxLeaseFreshness(reused);
      expect(readFileSync(fixture.statePath, "utf8")).toBe(saved);
      const reusedStat = statSync(fixture.statePath);
      expect(reusedStat.ino).toBe(originalStat.ino);
      expect(reusedStat.mtimeMs).toBe(originalStat.mtimeMs);
    }
  });

  it.each([
    {
      caller: "codex",
      env: { CODEX_THREAD_ID: "session-one" },
      changes: [{ CODEX_THREAD_ID: "session-two" }],
    },
    {
      caller: "claude",
      env: { CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "session-one" },
      changes: [{ CLAUDE_CODE_SESSION_ID: "session-two" }],
    },
    {
      caller: "github-actions",
      env: {
        CODEX_THREAD_ID: undefined,
        GITHUB_REPOSITORY: "example/project",
        GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "check",
      },
      changes: [{ GITHUB_RUN_ID: "101" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_JOB: "build" }],
    },
  ])("binds reuse to the $caller task", ({ caller, env, changes }) => {
    const fixture = createLeaseFixture();
    const prepared = fixture.allocate([], env);
    expect(prepared?.current.caller).toBe(caller);
    expect(fixture.reuse([], env)?.current).toEqual(prepared?.current);
    for (const change of changes) {
      expect(() => fixture.reuse([], { ...env, ...change })).toThrow("taskKey");
    }
  });

  it("rejects another worktree even at the same head and task", () => {
    const fixture = createLeaseFixture();
    const prepared = fixture.allocate();
    const worktree = join(fixture.root, "other-worktree");
    fixture.git(["worktree", "add", "--quiet", "--detach", worktree, "HEAD"]);

    expect(() => fixture.prepare(["run", "--id", "tbx_fixture"], {}, worktree)).toThrow(
      "checkoutKey",
    );
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toEqual(prepared?.current);
  });

  it("keeps raw checkout, session, label, and payload values out of provenance", () => {
    const fixture = createLeaseFixture();
    const session = "private-session-identifier";
    const label = "private-task-label";
    const payload = "private-command-payload";
    const prepared = fixture.prepare(
      [
        "run",
        "--keep",
        "--label",
        label,
        "--idle-timeout",
        "30m",
        "--ttl",
        "1h",
        "--",
        "echo",
        payload,
      ],
      { CODEX_THREAD_ID: session },
    );
    recordTestboxLeaseFreshness(prepared, "tbx_fixture");
    const serialized = JSON.stringify({
      current: prepared?.current,
      attribution: prepared?.attribution,
      saved: JSON.parse(readFileSync(fixture.statePath, "utf8")),
    });
    for (const value of [fixture.root, session, label, payload]) {
      expect(serialized).not.toContain(value);
    }
    expect(prepared?.current.taskKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared?.current.checkoutKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared?.attribution.commandKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared?.attribution.requestedIdleTimeout).toBe("30m");
    expect(prepared?.attribution.requestedTtl).toBe("1h");
  });

  it.each([
    ["withdrawn", "no allocation receipt"],
    ["reassigned", "taskKey"],
    ["old schema", "state schema"],
    ["missing HEAD", "headSha"],
    ["invalid HEAD", "headSha"],
  ])("rejects %s after preparation without refreshing allocation provenance", (change, message) => {
    const fixture = createLeaseFixture();
    fixture.allocate();
    const admitted = fixture.reuse();
    const original = readFileSync(fixture.statePath, "utf8");
    expect(() => admitted?.assertCurrent()).not.toThrow();
    if (change === "withdrawn") {
      rmSync(fixture.statePath);
    } else {
      const receipt = JSON.parse(original);
      if (change === "reassigned") {
        receipt.taskKey = "another-task";
      } else if (change === "old schema") {
        receipt.version = 1;
      } else {
        receipt.headSha = change === "missing HEAD" ? undefined : "invalid-sha";
      }
      writeFileSync(fixture.statePath, JSON.stringify(receipt));
    }
    const changedReceipt = existsSync(fixture.statePath)
      ? readFileSync(fixture.statePath, "utf8")
      : undefined;
    expect(() => admitted?.assertCurrent()).toThrow(message);
    expect(() => fixture.reuse()).toThrow(message);
    expect(admitted?.current.headSha).toBe(JSON.parse(original).headSha);
    if (changedReceipt === undefined) {
      expect(existsSync(fixture.statePath)).toBe(false);
    } else {
      expect(readFileSync(fixture.statePath, "utf8")).toBe(changedReceipt);
    }
  });

  it("ignores lease flags inside the command payload", () => {
    const fixture = createLeaseFixture();
    const env = { CODEX_THREAD_ID: undefined };
    const prepared = fixture.prepare(
      [
        "run",
        "--",
        "echo",
        "--id",
        "tbx_payload",
        "--label",
        "payload-task",
        "--keep",
        "--keep-on-failure",
        "--idle-timeout",
        "9h",
        "--ttl",
        "12h",
        "--blacksmith-workflow",
        "payload-workflow",
        "--blacksmith-job",
        "payload-job",
        "--blacksmith-ref",
        "payload-ref",
      ],
      env,
    );

    expect(prepared?.id).toBe("");
    expect(prepared?.current).toEqual(fixture.prepare(["run", "--", "true"], env)?.current);
    expect(prepared?.current.taskKey).toBe("");
    expect(prepared?.attribution.requestedIdleTimeout).toBeUndefined();
    expect(prepared?.attribution.requestedTtl).toBeUndefined();
  });

  it("allows operator one-shots and requires a task label to keep and reuse them", () => {
    const fixture = createLeaseFixture();
    const env = { CODEX_THREAD_ID: undefined };
    expect(fixture.prepare(["run", "--", "true"], env)?.current.caller).toBe("operator");
    for (const args of [["warmup"], ["run", "--keep"], ["run", "--keep-on-failure"]]) {
      expect(() => fixture.prepare(args, env)).toThrow("--label");
    }
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      for (const flag of ["keep", "keep-on-failure"]) {
        expect(() => fixture.prepare(["run", `--${flag}=${value}`], env)).toThrow("--label");
        expect(() =>
          fixture.prepare(["run", `--${flag}=${value}`, `--${flag}=false`], env),
        ).not.toThrow();
      }
    }
    const prepared = fixture.prepare(["run", "--keep", "--label", "task-one", "--", "true"], env);
    recordTestboxLeaseFreshness(prepared, "tbx_fixture");
    expect(fixture.reuse(["--label", "task-one"], env)?.current).toEqual(prepared?.current);
    expect(() => fixture.reuse(["--label", "task-two"], env)).toThrow("taskKey");
  });

  it.each([
    { args: ["run", "--", "true"], exitCode: 0, retained: false },
    { args: ["run", "--keep-on-failure", "--", "task"], exitCode: 0, retained: false },
    { args: ["run", "--keep-on-failure", "--", "task"], exitCode: 7, retained: true },
  ])("records retention=$retained for $args exiting $exitCode", ({ args, exitCode, retained }) => {
    const fixture = createLeaseFixture();
    const prepared = fixture.prepare(args);
    recordTestboxLeaseFreshness(prepared, "tbx_fixture", exitCode);
    expect(prepared?.attribution.operation).toBe("run");
    expect(existsSync(fixture.statePath)).toBe(retained);
  });
});

function createLeaseFixture() {
  const root = tempDirs.make("openclaw-testbox-freshness-");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Lease fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Lease fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", input }).trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  const tree = git(["write-tree"]);
  const initial = git(["commit-tree", tree], "Initial fixture\n");
  git(["update-ref", "HEAD", initial]);
  git(["update-ref", "refs/remotes/origin/main", initial]);
  const stateDir = join(root, "lease-state");
  const prepare = (args: string[], callerEnv: NodeJS.ProcessEnv = {}, repoRoot = root) =>
    prepareTestboxLeaseFreshness({
      repoRoot,
      provider: "blacksmith-testbox",
      args,
      env: {
        VITEST: "1",
        CODEX_THREAD_ID: "fixture-task",
        OPENCLAW_TESTBOX_LEASE_STATE_DIR: stateDir,
        ...callerEnv,
      },
    });
  const advanceHead = () => {
    const commit = git(["commit-tree", git(["write-tree"]), "-p", "HEAD"], "Advance fixture\n");
    git(["update-ref", "HEAD", commit]);
    return commit;
  };
  return {
    root,
    git,
    prepare,
    advanceHead,
    statePath: join(stateDir, "tbx_fixture.json"),
    advanceBase() {
      git(["update-ref", "refs/remotes/origin/main", advanceHead()]);
    },
    allocate(extraArgs: string[] = [], callerEnv: NodeJS.ProcessEnv = {}) {
      const prepared = prepare(["warmup", ...extraArgs], callerEnv);
      recordTestboxLeaseFreshness(prepared, "tbx_fixture");
      return prepared;
    },
    reuse(extraArgs: string[] = [], callerEnv: NodeJS.ProcessEnv = {}) {
      return prepare(["run", "--id", "tbx_fixture", ...extraArgs], callerEnv);
    },
  };
}

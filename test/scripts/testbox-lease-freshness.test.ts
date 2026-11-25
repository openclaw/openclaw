import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
} from "../../scripts/testbox-lease-freshness.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixture: ReturnType<typeof createLeaseFixture>;
beforeEach(() => {
  fixture = createLeaseFixture();
});

it("records and reuses a lease with more than a buffer of source deletions", () => {
  const blob = fixture.git(["hash-object", "-w", "--stdin"], "");
  const entries = Array.from(
    { length: 6_000 },
    (_, index) => `100644 ${blob}\t${String(index).padStart(4, "0")}-${"s".repeat(180)}.ts\n`,
  ).join("");
  fixture.git(["update-index", "--index-info"], entries);
  fixture.advanceBase();
  const output = execFileSync("git", ["-C", fixture.root, "status", "--porcelain=v1"], {
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(output.byteLength).toBeGreaterThan(1024 * 1024);
  const prepared = fixture.allocate();
  expect(prepared).not.toBeNull();
  expect(fixture.reuse()?.current).toEqual(prepared?.current);
});

it.each([".github/workflows/custom-testbox.yml", ""])(
  "tracks preparation owners with workflow %j",
  (workflow) => {
    const owners = [
      "scripts/crabbox-wrapper.mjs",
      ".github/actions/prepare-testbox-shell/action.yml",
      ...(workflow ? [workflow] : []),
    ];
    for (const owner of owners) {
      fixture.write(owner, "original\n");
    }
    fixture.git(["add", "."]);
    fixture.advanceBase();
    const options = { "blacksmith-workflow": workflow };
    fixture.allocate(options);
    const prepare = () => fixture.reuse(options);
    fixture.write("unrelated-source.ts", "source change\n");
    expect(() => prepare()).not.toThrow();
    for (const owner of owners) {
      fixture.write(owner, "changed executable owner\n");
      expect(() => prepare(), owner).toThrow("environmentDigest");
      fixture.write(owner, "original\n");
    }
  },
);

it.each(["baseSha", "dependencyDigest", "environmentDigest", "workflow", "job", "ref"])(
  "rejects recorded leases after %s changes",
  (field) => {
    const prepared = fixture.allocate();
    expect(prepared).not.toBeNull();
    const saved = readFileSync(fixture.statePath, "utf8");
    let options: Record<string, string> = {};
    if (field === "baseSha") {
      fixture.advanceBase();
    } else if (field === "dependencyDigest") {
      fixture.write("package.json", '{"name":"changed"}\n');
    } else if (field === "environmentDigest") {
      fixture.write(".node-version", "26.8.1\n");
    } else {
      options = { [`blacksmith-${field}`]: "changed" };
    }
    expect(() => fixture.reuse(options, { OPENCLAW_TESTBOX_ALLOW_STALE: "1" })).toThrow(field);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(saved);
  },
);

it("preserves failed-command allocation provenance across unchanged and changed source", () => {
  const allocation = fixture.prepare("run", { keep: "true" }, {}, fixture.root, [
    "run",
    "--keep",
    "--",
    "false",
  ]);
  recordTestboxLeaseFreshness(allocation, "tbx_fixture");
  const saved = readFileSync(fixture.statePath, "utf8");
  const originalStat = statSync(fixture.statePath);
  for (const change of ["unchanged", "empty commit", "source commit"]) {
    if (change === "source commit") {
      fixture.write("source.ts", "export const value = 2;\n");
      fixture.git(["add", "source.ts"]);
    }
    const head = change === "unchanged" ? allocation?.current.headSha : fixture.advanceHead();
    const reused = fixture.reuse({}, {}, ["run", "--id", "tbx_fixture", "--", "pnpm", "test"]);
    expect(reused?.current).toEqual({ ...allocation?.current, headSha: head });
    expect(reused?.attribution.headSha).toBe(head);
    expect(reused?.attribution.commandKey).not.toBe(allocation?.attribution.commandKey);
    expect(() => reused?.assertCurrent()).not.toThrow();
    recordTestboxLeaseFreshness(reused);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(saved);
    const reusedStat = statSync(fixture.statePath);
    expect(reusedStat).toMatchObject({ ino: originalStat.ino, mtimeMs: originalStat.mtimeMs });
  }
});

it.each([
  ["claude", ["CLAUDE_CODE_SESSION_ID"]],
  ["github-actions", ["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB"]],
] as const)("binds reuse to the %s task", (caller, keys) => {
  const env = {
    ...Object.fromEntries(keys.map((key) => [key, "original"])),
    CODEX_THREAD_ID: undefined,
  };
  const prepared = fixture.allocate({}, env);
  expect(prepared?.current.caller).toBe(caller);
  expect(fixture.reuse({}, env)?.current).toEqual(prepared?.current);
  for (const key of keys) {
    expect(() => fixture.reuse({}, { ...env, [key]: "changed" })).toThrow("taskKey");
  }
});

it("rejects another worktree even at the same head and task", () => {
  const prepared = fixture.allocate();
  const worktree = join(fixture.root, "other-worktree");
  fixture.git(["worktree", "add", "--quiet", "--detach", worktree, "HEAD"]);

  expect(() => fixture.prepare("run", { id: "tbx_fixture" }, {}, worktree)).toThrow("checkoutKey");
  expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toEqual(prepared?.current);
});

it("keeps raw checkout, session, label, and payload values out of provenance", () => {
  const session = "private-session-identifier";
  const label = "private-task-label";
  const payload = "private-command-payload";
  const prepared = fixture.prepare(
    "run",
    { keep: "true", label, "idle-timeout": "30m", ttl: "1h" },
    { CODEX_THREAD_ID: session },
    fixture.root,
    ["run", "--keep", `--label=${label}`, "--idle-timeout=30m", "--ttl=1h", "--", payload],
  );
  recordTestboxLeaseFreshness(prepared, "tbx_fixture");
  const serialized = JSON.stringify([prepared?.current, prepared?.attribution, fixture.receipt()]);
  for (const value of [fixture.root, session, label, payload]) {
    expect(serialized).not.toContain(value);
  }
  for (const key of [
    prepared?.current.taskKey,
    prepared?.current.checkoutKey,
    prepared?.attribution.commandKey,
  ]) {
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
  }
  expect(prepared?.attribution).toMatchObject({
    requestedIdleTimeout: "30m",
    requestedTtl: "1h",
  });
});

it.each([
  ["taskKey", "another-task", "taskKey"],
  ["version", 1, "state schema"],
  ["headSha", undefined, "headSha"],
  ["headSha", "invalid-sha", "headSha"],
] as const)("rejects changed %s=%s without refreshing provenance", (field, value, message) => {
  fixture.allocate();
  const admitted = fixture.reuse();
  const original = fixture.receipt();
  expect(() => admitted?.assertCurrent()).not.toThrow();
  const receipt = { ...original, [field]: value };
  const changedReceipt = JSON.stringify(receipt);
  writeFileSync(fixture.statePath, changedReceipt);
  expect(() => admitted?.assertCurrent()).toThrow(message);
  expect(() => fixture.reuse()).toThrow(message);
  expect(admitted?.current.headSha).toBe(original.headSha);
  expect(readFileSync(fixture.statePath, "utf8")).toBe(changedReceipt);
});

it("keeps command provenance separate from prepared lease options", () => {
  const env = { CODEX_THREAD_ID: undefined };
  const payload = [
    "id",
    "label",
    "idle-timeout",
    "ttl",
    "blacksmith-workflow",
    "blacksmith-job",
    "blacksmith-ref",
  ];
  const prepared = fixture.prepare("run", {}, env, fixture.root, [
    "run",
    "--",
    "echo",
    ...payload.flatMap((flag) => [`--${flag}`, "payload"]),
    "--keep",
    "--keep-on-failure",
  ]);

  expect(prepared?.id).toBe("");
  expect(prepared?.current).toEqual(fixture.prepare("run", {}, env)?.current);
  expect(prepared?.current.taskKey).toBe("");
  expect(prepared?.attribution).toMatchObject({
    requestedIdleTimeout: undefined,
    requestedTtl: undefined,
  });
});

it("allows operator one-shots and requires a task label to keep and reuse them", () => {
  const env = { CODEX_THREAD_ID: undefined };
  expect(fixture.prepare("run", {}, env)?.current.caller).toBe("operator");
  expect(() => fixture.prepare("warmup", {}, env)).toThrow("--label");
  for (const flag of ["keep", "keep-on-failure"]) {
    expect(() => fixture.prepare("run", { [flag]: "true" }, env)).toThrow("--label");
    expect(() => fixture.prepare("run", { [flag]: "false" }, env)).not.toThrow();
  }
  const prepared = fixture.prepare("run", { keep: "true", label: "task-one" }, env);
  recordTestboxLeaseFreshness(prepared, "tbx_fixture");
  expect(fixture.reuse({ label: "task-one" }, env)?.current).toEqual(prepared?.current);
  expect(() => fixture.reuse({ label: "task-two" }, env)).toThrow("taskKey");
});

function createLeaseFixture() {
  const root = tempDirs.make("openclaw-testbox-freshness-");
  const write = (file: string, content: string) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
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
  for (const relative of [
    ".github/actions/setup-node-env/dependency-fingerprint.mjs",
    "scripts/lib/pnpm-lockfile-documents.mjs",
  ]) {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(new URL("../../" + relative, import.meta.url), file);
  }
  write("package.json", '{"name":"lease-fixture","private":true}\n');
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  git(["add", "."]);
  const tree = git(["write-tree"]);
  const initial = git(["commit-tree", tree], "Initial fixture\n");
  git(["update-ref", "HEAD", initial]);
  git(["update-ref", "refs/remotes/origin/main", initial]);
  const stateDir = join(root, "lease-state");
  const prepare = (
    operation: string,
    options: Record<string, string> = {},
    callerEnv: NodeJS.ProcessEnv = {},
    repoRoot = root,
    command: readonly string[] = [operation],
  ) =>
    prepareTestboxLeaseFreshness({
      repoRoot,
      provider: "blacksmith-testbox",
      operation,
      options: new Map(Object.entries(options)),
      command,
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
    write,
    git,
    prepare,
    advanceHead,
    statePath: join(stateDir, "tbx_fixture.json"),
    receipt: () => JSON.parse(readFileSync(join(stateDir, "tbx_fixture.json"), "utf8")),
    advanceBase() {
      git(["update-ref", "refs/remotes/origin/main", advanceHead()]);
    },
    allocate(options: Record<string, string> = {}, callerEnv: NodeJS.ProcessEnv = {}) {
      const prepared = prepare("warmup", options, callerEnv);
      recordTestboxLeaseFreshness(prepared, "tbx_fixture");
      return prepared;
    },
    reuse(
      options: Record<string, string> = {},
      callerEnv: NodeJS.ProcessEnv = {},
      command: readonly string[] = ["run"],
    ) {
      return prepare("run", { id: "tbx_fixture", ...options }, callerEnv, root, command);
    },
  };
}

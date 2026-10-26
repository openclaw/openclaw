import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const repository = "openclaw/openclaw";
const restoreName = "Restore exact trusted workflow revision";
type Workflow = {
  jobs: Record<string, { steps: { name?: string; run?: string; env?: Record<string, string> }[] }>;
};
type Fault =
  | "different-caller"
  | "already-Q"
  | "foreign-remote"
  | "malformed-Q"
  | "missing-Q"
  | "wrong-head"
  | "symlink";

function fixture(file: string, jobName: string, fault: Fault) {
  const workflow = parse(readFileSync(file, "utf8")) as Workflow;
  const restoration = workflow.jobs[jobName]?.steps.find((step) => step.name === restoreName);
  const script = restoration?.run;
  const harnessPath = restoration?.env?.HARNESS_PATH;
  if (!script || !harnessPath) {
    throw new Error("Missing actual workflow restore step");
  }
  const root = realpathSync(temporary.make("workflow-harness-restore-"));
  const upstream = join(root, "upstream");
  const harness = join(root, harnessPath);
  const bin = join(root, "bin");
  const trace = join(root, "git-calls.jsonl");
  const config = join(root, "empty-git-config");
  mkdirSync(upstream);
  mkdirSync(dirname(harness), { recursive: true });
  mkdirSync(bin);
  writeFileSync(config, "");
  writeFileSync(trace, "");
  const originalPath = dirname(process.execPath) + delimiter + (process.env.PATH ?? "");
  const env = {
    PATH: originalPath,
    HOME: root,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Workflow fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Workflow fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(upstream, "init", "--initial-branch=main");
  writeFileSync(join(upstream, "harness-source"), "caller");
  git(upstream, "add", "harness-source");
  git(upstream, "commit", "-m", "caller seed");
  const caller = git(upstream, "rev-parse", "HEAD");
  git(upstream, "branch", "seed");
  writeFileSync(join(upstream, "harness-source"), "callee");
  git(upstream, "add", "harness-source");
  git(upstream, "commit", "-m", "callee qualification");
  const qualification = git(upstream, "rev-parse", "HEAD");
  git(
    root,
    "clone",
    "--depth=1",
    "--branch",
    fault === "already-Q" ? "main" : "seed",
    pathToFileURL(upstream).href,
    harness,
  );
  git(
    harness,
    "remote",
    "set-url",
    "origin",
    fault === "foreign-remote"
      ? "https://github.com/foreign/openclaw.git"
      : "https://github.com/openclaw/openclaw.git",
  );
  if (fault === "symlink") {
    const other = join(root, "other-harness");
    renameSync(harness, other);
    symlinkSync(other, harness, "dir");
  }
  // Only transport is substituted. All ref/object/checkout operations use real Git.
  // An unexpected ref or fallback is refused instead of contacting a remote host.
  writeFileSync(
    join(bin, "git"),
    [
      "#!" + process.execPath,
      'const { appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      'if (args[0] !== "-C" || args[1] !== process.env.HARNESS_DIRECTORY) process.exit(64);',
      'appendFileSync(process.env.GIT_TRACE_PATH, JSON.stringify(args.slice(2)) + "\\n");',
      'if (args[2] === "fetch") {',
      '  const expected = ["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", process.env.WORKFLOW_SHA];',
      "  if (JSON.stringify(args.slice(2)) !== JSON.stringify(expected)) process.exit(65);",
      "  args[6] = process.env.LOCAL_UPSTREAM;",
      "}",
      'if (args[2] === "checkout" && process.env.RESTORE_FAULT === "wrong-head") process.exit(0);',
      'const result = spawnSync("git", args, { env: { ...process.env, PATH: process.env.ORIGINAL_PATH }, encoding: "utf8" });',
      'process.stdout.write(result.stdout || "");',
      'process.stderr.write(result.stderr || "");',
      "process.exit(result.status ?? 1);",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...env,
      PATH: bin + delimiter + originalPath,
      ORIGINAL_PATH: originalPath,
      LOCAL_UPSTREAM: upstream,
      GIT_TRACE_PATH: trace,
      HARNESS_DIRECTORY: harness,
      HARNESS_PATH: harnessPath,
      WORKFLOW_REPOSITORY: repository,
      WORKFLOW_SHA:
        fault === "malformed-Q" ? "main" : fault === "missing-Q" ? "f".repeat(40) : qualification,
      RESTORE_FAULT: fault,
    },
  });
  const calls = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return {
    result,
    calls,
    caller,
    qualification,
    head: git(harness, "rev-parse", "HEAD"),
    source: readFileSync(join(harness, "harness-source"), "utf8"),
  };
}

// These acquisition jobs run on Ubuntu; the script contract is Bash plus native Git.
describe.skipIf(process.platform === "win32").each([
  {
    label: "installer warning relay",
    file: ".github/workflows/install-smoke-reusable.yml",
    job: "install-smoke-fast",
  },
  {
    label: "installer harness",
    file: ".github/workflows/install-smoke-reusable.yml",
    job: "root_dockerfile_image",
  },
  {
    label: "candidate evidence binder",
    file: ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
    job: "bind_full_release_candidate_evidence",
  },
])("authenticated frozen harness: $label", ({ file, job }) => {
  it.each<Fault>([
    "different-caller",
    "already-Q",
    "foreign-remote",
    "malformed-Q",
    "missing-Q",
    "wrong-head",
    "symlink",
  ])("preserves callee authority with %s", (fault) => {
    const f = fixture(file, job, fault);
    const succeeds = fault === "different-caller" || fault === "already-Q";
    expect(f.result.status === 0, f.result.stderr).toBe(succeeds);
    expect(f.head).toBe(succeeds ? f.qualification : f.caller);
    expect(f.source).toBe(succeeds ? "callee" : "caller");
    const fetches = f.calls.filter((args) => args[0] === "fetch");
    if (["already-Q", "foreign-remote", "malformed-Q", "symlink"].includes(fault)) {
      expect(fetches).toEqual([]);
    } else {
      expect(fetches).toHaveLength(1);
      expect(fetches[0]?.at(-1)).toBe(fault === "missing-Q" ? "f".repeat(40) : f.qualification);
    }
    if (fault === "missing-Q") {
      expect(f.calls.some((args) => args[0] === "checkout")).toBe(false);
    }
    if (fault === "wrong-head") {
      expect(f.result.stderr).toContain("did not resolve to the authenticated workflow SHA");
    }
  });
});

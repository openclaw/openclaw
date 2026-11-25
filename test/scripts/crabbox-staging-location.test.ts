import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareCrabboxSourceCapsule } from "../../scripts/crabbox-source-capsule.mts";
import { preserveCrabboxArtifacts } from "../../scripts/crabbox-staging-artifacts.mts";
import { canRecordStaging, stagingPrefix } from "../../scripts/crabbox-staging-location.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
const generation = stagingPrefix + "123e4567-e89b-42d3-a456-426614174000";

function fixture(ignore = "") {
  const root = temporary.make("openclaw-staging-location-");
  const repository = join(root, "repository");
  const home = join(root, "home");
  mkdirSync(repository);
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, "state"),
    GIT_CONFIG_GLOBAL: join(home, "empty-global"),
    GIT_CONFIG_SYSTEM: join(home, "empty-system"),
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  delete env.GIT_CONFIG_PARAMETERS;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(repository, "init", "--quiet", "--initial-branch=main", "--template=");
  git(repository, "remote", "add", "origin", "https://example.invalid/fixture.git");
  writeFileSync(join(repository, "source.txt"), "original source\n");
  writeFileSync(join(repository, ".gitignore"), ignore);
  git(repository, "add", "source.txt", ".gitignore");
  git(repository, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ]) {
    vi.stubEnv(key, env[key]);
  }
  vi.stubEnv("CRABBOX_CONFIG", undefined);
  const prepare = (syncRoot: string) =>
    prepareCrabboxSourceCapsule({
      repoRoot: repository,
      syncRoot,
      base: "HEAD",
      // Only the external selection response is a fixture. The producer and its
      // registration, raw-tree sealing, lifecycle, and cleanup remain real.
      syncPlan: {
        command: process.execPath,
        args: [
          "-e",
          String.raw`
const {execFileSync}=require("node:child_process");
const files=[...new Set(execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8"}).split("\0").filter(Boolean))];
process.stdout.write(JSON.stringify({candidate:{files:files.length},topFiles:files.map(path=>({path}))}));`,
        ],
      },
    });
  return { root, repository, home, env, git, prepare };
}

it.each(["directory", "alias"] as const)(
  "runs repo-local staging through a %s without recovery records",
  (kind) => {
    const f = fixture(kind === "alias" ? "stages/\n" : "");
    const index = f.git(f.repository, "ls-files", "--stage");
    const inside = join(f.repository, "stages");
    const syncRoot = kind === "alias" ? join(f.root, "alias") : inside;
    if (kind === "alias") {
      mkdirSync(inside);
      symlinkSync(inside, syncRoot, process.platform === "win32" ? "junction" : "dir");
      expect(canRecordStaging(join(syncRoot, generation), f.repository, f.env)).toBe(false);
    }
    const capsule = f.prepare(syncRoot);
    try {
      expect(capsule.staging.recorded).toBe(false);
      capsule.staging.admitted();
      capsule.staging.settled();
      const artifacts = preserveCrabboxArtifacts(capsule.directory, f.repository);
      if (!artifacts) {
        throw new Error("Fixture expected disposable source artifact evidence");
      }
      capsule.staging.preserved(artifacts);
      expect(readdirSync(capsule.staging.root)).toEqual(["payload"]);
      expect(readdirSync(capsule.staging.payload)).toEqual(["source"]);
      expect(
        f.git(capsule.directory, "ls-tree", "-r", "--name-only", capsule.tree).split("\n"),
      ).toEqual([".gitignore", "source.txt"]);
      expect(readFileSync(join(capsule.directory, "source.txt"), "utf8")).toBe("original source\n");
      expect(f.git(f.repository, "ls-files", "--stage")).toBe(index);
    } finally {
      capsule.cleanup();
    }
    expect(readdirSync(syncRoot)).toEqual([]);
    expect(readFileSync(join(f.repository, "source.txt"), "utf8")).toBe("original source\n");
  },
);

it("reevaluates registration when staging roots and ignore rules change", () => {
  const f = fixture();
  const local = join(f.repository, "stages");
  for (const [syncRoot, ignore, recorded] of [
    [join(f.root, "external-staging"), "", true],
    [local, "stages/\n", false],
    [local, "", false],
  ] as const) {
    writeFileSync(join(f.repository, ".gitignore"), ignore);
    vi.stubEnv("OPENCLAW_CRABBOX_SYNC_TMPDIR", syncRoot);
    const capsule = f.prepare(syncRoot);
    try {
      expect(capsule.staging.recorded).toBe(recorded);
      expect(existsSync(join(capsule.staging.root, "staging.json"))).toBe(recorded);
      expect(existsSync(join(capsule.staging.root, "manifest.json"))).toBe(recorded);
    } finally {
      capsule.cleanup();
    }
  }
});

it("requires known placement outside the effective Git workspace before recording", () => {
  const f = fixture();
  const source = join(f.repository, "packages", "source");
  mkdirSync(source, { recursive: true });
  const override = {
    ...f.env,
    GIT_CONFIG_COUNT: "invalid",
  };
  const rejected = spawnSync("git", ["-C", source, "rev-parse", "--show-toplevel"], {
    env: override,
    encoding: "utf8",
  });
  expect(rejected.error).toBeUndefined();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("GIT_CONFIG_COUNT");
  const alternate = join(f.root, "alternate-workspace");
  mkdirSync(alternate);
  const stage = join(f.root, "external-staging", generation);
  const nativeCwd = join(stage, "payload", "source");
  mkdirSync(nativeCwd, { recursive: true });
  const relativeRouting = {
    ...f.env,
    GIT_DIR: join(f.repository, ".git"),
    GIT_WORK_TREE: "../..",
  };
  for (const [cwd, expected] of [
    [source, f.repository],
    [nativeCwd, stage],
  ] as const) {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      // Native Crabbox resolves explicit relative routing against its child cwd.
      env: { ...relativeRouting, GIT_WORK_TREE: resolve(cwd, relativeRouting.GIT_WORK_TREE) },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(normalize(result.stdout.trim())).toBe(normalize(expected));
  }
  const root = join(f.root, "unknown-staging", generation);
  const file = join(f.root, "not-a-directory");
  writeFileSync(file, "fixture\n");
  const cases: [string, string, NodeJS.ProcessEnv, boolean][] = [
    [join(f.repository, "stages", generation), source, f.env, false],
    [stage, source, f.env, true],
    [join(f.repository, "stages", generation), source, override, false],
    [stage, source, override, true],
    [join(alternate, generation), f.repository, { ...f.env, GIT_WORK_TREE: alternate }, false],
    [stage, source, relativeRouting, false],
    [stage, f.repository, { ...f.env, GIT_DIR: ".git" }, false],
    [root, join(f.root, "missing-source"), f.env, false],
    [root, f.repository, { ...f.env, PATH: join(f.root, "missing-bin") }, false],
    [join(file, generation), f.repository, f.env, false],
  ];
  for (const [candidate, repository, env, recorded] of cases) {
    expect(canRecordStaging(candidate, repository, env), candidate).toBe(recorded);
  }
  expect(existsSync(root)).toBe(false);
});

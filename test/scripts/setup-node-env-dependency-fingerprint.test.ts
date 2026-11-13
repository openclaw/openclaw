import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve(".github/actions/setup-node-env/dependency-fingerprint.mjs");

it("fingerprints dependency install inputs without ordinary script churn", () => {
  const { git, write, json, remove, fingerprint } = createFingerprintFixture();
  const writeManifest = (manifest: Record<string, unknown>) => json("package.json", manifest);
  const unrelatedManifest = "other/package.json";
  const writeOther = (version = "1.0.0") => json(unrelatedManifest, { name: "other", version });
  const writeLock = (lock: string) => write("pnpm-lock.yaml", lock);
  const expectOtherInvalidation = (previous: string, included = true) => {
    writeOther("2.0.0");
    expect(fingerprint() !== previous).toBe(included);
    writeOther();
  };
  const lockWith = (value: string) => `importers:\n  .:\n    dependencies:\n      other:${value}\n`;
  const lifecycleScripts = {
    "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
    postinstall: "node scripts/postinstall-bundled-plugins.mjs",
    preinstall: "node scripts/preinstall-package-manager-warning.mjs",
    prepare: "node scripts/prepare-git-hooks.mjs",
  };
  const manifest = {
    name: "fixture",
    scripts: { ...lifecycleScripts, test: "vitest run" },
    devDependencies: { vitest: "1.0.0" },
  };
  writeManifest({ ...manifest, openclaw: { schemaVersions: { agent: 17, state: 6 } } });
  const frozenLock =
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/worker: {}\nsnapshots:\n  example@1.0.0:\n    dependencies:\n      get-caller-file: 2.0.5\n";
  writeLock(frozenLock);
  writeOther();
  git(["add", "package.json", "pnpm-lock.yaml", unrelatedManifest]);
  const baseline = fingerprint();
  const mutableBaseline = fingerprint(false);
  writeOther("2.0.0");
  expect(fingerprint()).toBe(baseline);
  expect(fingerprint(false)).not.toBe(mutableBaseline);
  json(unrelatedManifest, { name: "other", scripts: { prepare: "node build.mjs" } });
  expect(fingerprint()).toBe(baseline);
  expect(() => fingerprint(false)).toThrow(/unaudited install lifecycle scripts/);
  writeOther();
  for (const [lock, included] of [
    // pnpm 12 separates the package-manager environment from workspace importers.
    ["---\nlockfileVersion: '9.0'\nimporters:\n  .: {}\n---\n" + frozenLock, false],
    [lockWith("\n        version: link:other"), true],
    [lockWith(" {specifier: file:other, version: file:other}"), true],
    // Shapes outside the dependency-free reader retain conservative coverage.
    ["importers: {'.': {}}\n", true],
    ["importers:\n  '.': {}\n", true],
  ] as const) {
    writeLock(lock);
    expectOtherInvalidation(fingerprint(), included);
  }
  writeLock(frozenLock);
  for (const [file, contents] of [
    [".npmrc", "pnpmfile=tools/hooks.cjs\n"],
    ["pnpm-workspace.yaml", "pnpmfile: tools/hooks.cjs\n"],
  ] as const) {
    write(file, contents);
    expectOtherInvalidation(fingerprint());
    remove(file);
  }
  write(".pnpmfile.cjs", "<missing>");
  const hookFingerprint = fingerprint();
  expect(hookFingerprint).not.toBe(baseline);
  expectOtherInvalidation(hookFingerprint);
  remove(".pnpmfile.cjs");
  for (const installInput of [
    ".github/actions/setup-node-env/install-dependencies.sh",
    "runtime-process-bootstrap.generated.mjs",
    "runtime-process-scripts.generated.mjs",
    "scripts/lib/fs-safe-npm-cli-preload.generated.mjs",
    "scripts/lib/fs-safe-npm-cli-protocol.mjs",
  ]) {
    write(installInput, "first fixture\n");
    const first = fingerprint();
    expect(first, installInput).not.toBe(baseline);
    write(installInput, "changed fixture\n");
    expect(fingerprint(), installInput).not.toBe(first);
    remove(installInput);
  }
  writeManifest({
    ...Object.fromEntries(Object.entries(manifest).toReversed()),
    scripts: {
      test: "vitest run --reporter=dot",
      ...Object.fromEntries(Object.entries(lifecycleScripts).toReversed()),
    },
  });
  expect(fingerprint()).toBe(baseline);
  writeManifest({ ...manifest, devDependencies: { vitest: "2.0.0" } });
  expect(fingerprint()).not.toBe(baseline);
  writeManifest({
    ...manifest,
    scripts: { postinstall: "node install-v2.mjs", test: "vitest run" },
  });
  expect(() => fingerprint()).toThrow(/unaudited install lifecycle scripts in package\.json/);
  writeManifest({ ...manifest, scripts: lifecycleScripts });
  const workerManifest = "packages/worker/package.json";
  json(workerManifest, { name: "worker", scripts: { prepare: "node build.mjs" } });
  git(["add", workerManifest]);
  writeLock(frozenLock.replace("  packages/worker:", "# group\n  packages/worker:"));
  expect(() => fingerprint()).toThrow(
    /unaudited install lifecycle scripts in packages\/worker\/package\.json/,
  );
});

it("preserves sparse-index install inputs without materializing them", () => {
  const { root, git, write, remove, fingerprint, initial } = createSparseFingerprintFixture();
  const stagedManifest = '{"name":"worker","version":"2.0.0"}\n';
  write("packages/worker/package.json", stagedManifest);
  git(["add", "packages/worker/package.json"]);
  const staged = fingerprint();
  expect(staged).not.toBe(initial);
  git(["sparse-checkout", "init", "--cone", "--sparse-index"]);
  git(["sparse-checkout", "set", ".github"]);
  expect(git(["ls-files", "--sparse", "--stage"])).toContain("040000 ");
  const worker = path.join(root, "packages/worker/package.json");
  expect(fingerprint()).toBe(staged);
  expect(existsSync(worker)).toBe(false);
  write("packages/worker/package.json", '{"name":"worker","version":"3.0.0"}\n');
  git(["update-index", "--skip-worktree", "packages/worker/package.json"]);
  expect(fingerprint()).not.toBe(staged);
  remove("packages/worker/package.json");
  expect(fingerprint()).toBe(staged);
  // Cone mode retains root files; omit them explicitly.
  for (const file of [".npmrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", "pnpm-lock.yaml"]) {
    git(["update-index", "--skip-worktree", file]);
    remove(file);
  }
  expect(fingerprint()).toBe(staged);
  symlinkSync("missing-manifest", worker);
  expect(() => fingerprint()).toThrow(/ENOENT/);
  remove("packages");
  symlinkSync("missing-packages", path.join(root, "packages"));
  expect(() => fingerprint()).toThrow(/non-directory ancestor/);
  remove("packages");
  git(["update-index", "--no-skip-worktree", "packages/worker/package.json"]);
  expect(() => fingerprint()).toThrow(/tracked install input is missing/);
  git(["update-index", "--skip-worktree", "packages/worker/package.json"]);
  write("patches/dependency.patch", "changed patch bytes\n");
  expect(fingerprint()).not.toBe(staged);
});

it("uses staged additions and deletions without reading HEAD as a fallback", () => {
  const { git, write, remove, fingerprint, initial } = createSparseFingerprintFixture();
  write("packages/added/package.json", '{"name":"added"}\n');
  git(["add", "packages/added/package.json"]);
  const added = fingerprint();
  expect(added).not.toBe(initial);
  git(["update-index", "--skip-worktree", "packages/added/package.json"]);
  remove("packages/added");
  expect(fingerprint()).toBe(added);
  git(["update-index", "--force-remove", "packages/added/package.json"]);
  expect(fingerprint()).toBe(initial);
});

it("keeps physical skip-worktree bytes independent of unavailable index objects", () => {
  const { git, write, remove, fingerprint, initial: original } = createSparseFingerprintFixture();
  const present = "packages/worker/package.json";
  git(["update-index", "--info-only", "--cacheinfo", "100644", "1".repeat(40), present]);
  git(["update-index", "--skip-worktree", present]);
  const absent = "scripts/postinstall-bundled-plugins.mjs";
  git(["update-index", "--skip-worktree", absent]);
  remove(absent);
  expect(fingerprint()).toBe(original);
  write(present, '{"name":"worker","version":"2.0.0"}\n');
  expect(fingerprint()).not.toBe(original);
  remove(present);
  expect(() => fingerprint()).toThrow(/could not read sparse install input/);
});

it("rejects unmerged index inputs", () => {
  const { git, fingerprint } = createSparseFingerprintFixture();
  const file = "packages/worker/package.json";
  const oid = git(["rev-parse", ":" + file]);
  git(
    ["update-index", "--index-info"],
    `0 ${"0".repeat(40)}\t${file}\n100644 ${oid} 1\t${file}\n100644 ${oid} 2\t${file}\n`,
  );
  expect(() => fingerprint()).toThrow(/requires resolved file index entries/);
});

function createFingerprintFixture() {
  const root = tempDirs.make("openclaw-dependency-fingerprint-");
  const run = (command: string, args: string[], input?: string) =>
    execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      input,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  const write = (file: string, contents: string) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const git = (args: string[], input?: string) => run("git", args, input);
  git(["init", "-q"]);
  return {
    root,
    git,
    write,
    json: (file: string, value: unknown) => write(file, `${JSON.stringify(value, null, 2)}\n`),
    remove: (file: string) => rmSync(path.join(root, file), { recursive: true }),
    fingerprint: (frozen = true) =>
      run(process.execPath, [helper, "--workspace", root, "--frozen-lockfile", String(frozen)]),
  };
}

function createSparseFingerprintFixture() {
  const fixture = createFingerprintFixture();
  const { git, write } = fixture;
  for (const [file, contents] of [
    ["package.json", '{"name":"fixture"}\n'],
    ["packages/worker/package.json", '{"name":"worker","version":"1.0.0"}\n'],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/worker: {}\n"],
    ["pnpm-workspace.yaml", "packages:\n  - packages/*\n"],
    [".npmrc", "auto-install-peers=true\n"],
    [".pnpmfile.cjs", "module.exports = { hooks: {} };\n"],
    ["scripts/postinstall-bundled-plugins.mjs", "// install owner\n"],
    ["patches/dependency.patch", "original patch bytes\n"],
    [".github/keep.txt", "kept directory\n"],
  ]) {
    write(file!, contents!);
  }
  git(["add", "."]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["commit", "-qm", "fixture"]);
  return { ...fixture, initial: fixture.fingerprint() };
}

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("fingerprints dependency install inputs without ordinary script churn", () => {
  const root = tempDirs.make("openclaw-dependency-fingerprint-");
  const helper = path.resolve(".github/actions/setup-node-env/dependency-fingerprint.mjs");
  const writeManifest = (manifest: Record<string, unknown>) => {
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const fingerprint = (frozenLockfile = true) =>
    execFileSync(
      process.execPath,
      [helper, "--workspace", root, "--frozen-lockfile", frozenLockfile ? "true" : "false"],
      { encoding: "utf8" },
    ).trim();

  execFileSync("git", ["init", "-q"], { cwd: root });
  writeManifest({
    name: "fixture",
    openclaw: { schemaVersions: { agent: 17, state: 6 } },
    scripts: {
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
      prepare: "node scripts/prepare-git-hooks.mjs",
      test: "vitest run",
    },
    devDependencies: { vitest: "1.0.0" },
  });
  const frozenLock =
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/worker: {}\n" +
    "snapshots:\n  example@1.0.0:\n    dependencies:\n      get-caller-file: 2.0.5\n";
  writeFileSync(path.join(root, "pnpm-lock.yaml"), frozenLock);
  const unrelatedManifest = path.join(root, "test", "fixtures", "other", "package.json");
  mkdirSync(path.dirname(unrelatedManifest), { recursive: true });
  writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "1.0.0" }));
  execFileSync("git", ["add", "package.json", "pnpm-lock.yaml", unrelatedManifest], {
    cwd: root,
  });

  const baseline = fingerprint();
  expect(baseline).toMatch(/^v2-[a-f0-9]{64}$/);

  const mutableBaseline = fingerprint(false);
  writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "2.0.0" }));
  expect(fingerprint()).toBe(baseline);
  expect(fingerprint(false)).not.toBe(mutableBaseline);
  writeFileSync(
    unrelatedManifest,
    JSON.stringify({ name: "other", scripts: { prepare: "node build.mjs" } }),
  );
  expect(fingerprint()).toBe(baseline);
  expect(() => fingerprint(false)).toThrow(/unaudited install lifecycle scripts/);
  writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "1.0.0" }));

  for (const [lock, included] of [
    // pnpm 12 separates the package-manager environment from workspace importers.
    ["---\nlockfileVersion: '9.0'\nimporters:\n  .: {}\n---\n" + frozenLock, false],
    [
      "importers:\n  .:\n    dependencies:\n      other:\n        version: link:test/fixtures/other\n",
      true,
    ],
    [
      "importers:\n  .:\n    dependencies:\n      other: {specifier: file:test/fixtures/other, version: file:test/fixtures/other}\n",
      true,
    ],
    // Shapes outside the dependency-free reader retain conservative coverage.
    ["importers: {'.': {}}\n", true],
    ["importers:\n  '.': {}\n", true],
    [
      "importers:\n  .:\n    dependencies:\n      other:\n        version: file:test/fixtures/other\n",
      true,
    ],
  ] as const) {
    writeFileSync(path.join(root, "pnpm-lock.yaml"), lock);
    const previous = fingerprint();
    writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "2.0.0" }));
    expect(fingerprint() !== previous, lock).toBe(included);
    writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "1.0.0" }));
  }
  writeFileSync(path.join(root, "pnpm-lock.yaml"), frozenLock);

  for (const [file, contents] of [
    [".npmrc", "pnpmfile=tools/hooks.cjs\n"],
    ["pnpm-workspace.yaml", "pnpmfile: tools/hooks.cjs\n"],
  ] as const) {
    const config = path.join(root, file);
    writeFileSync(config, contents);
    const configuredHookFingerprint = fingerprint();
    writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "2.0.0" }));
    expect(fingerprint()).not.toBe(configuredHookFingerprint);
    writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "1.0.0" }));
    rmSync(config);
  }

  // Presence is part of the record type, so a real file cannot collide
  // with the representation of an absent optional install input.
  writeFileSync(path.join(root, ".pnpmfile.cjs"), "<missing>");
  const hookFingerprint = fingerprint();
  expect(hookFingerprint).not.toBe(baseline);
  writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "2.0.0" }));
  expect(fingerprint()).not.toBe(hookFingerprint);
  writeFileSync(unrelatedManifest, JSON.stringify({ name: "other", version: "1.0.0" }));
  rmSync(path.join(root, ".pnpmfile.cjs"));
  expect(fingerprint()).toBe(baseline);

  writeFileSync(path.join(root, ".pnpmfile.mjs"), "export const hooks = {};\n");
  const mjsHookFingerprint = fingerprint();
  expect(mjsHookFingerprint).not.toBe(baseline);
  writeFileSync(
    path.join(root, ".pnpmfile.mjs"),
    "export const hooks = { readPackage: (pkg) => pkg };\n",
  );
  expect(fingerprint()).not.toBe(mjsHookFingerprint);
  rmSync(path.join(root, ".pnpmfile.mjs"));
  expect(fingerprint()).toBe(baseline);

  for (const relativePath of [
    "node-version.mjs",
    ".github/actions/setup-node-env/install-dependencies.sh",
    "scripts/check-install-dependency-ownership.mjs",
    "scripts/prepare-git-hooks.mjs",
    "scripts/lib/package-lifecycle-marker.mjs",
    "scripts/lib/pnpm-lockfile-documents.mjs",
  ]) {
    const inputPath = path.join(root, relativePath);
    mkdirSync(path.dirname(inputPath), { recursive: true });
    writeFileSync(inputPath, "fixture\n");
    expect(fingerprint(), relativePath).not.toBe(baseline);
    rmSync(inputPath);
    expect(fingerprint(), relativePath).toBe(baseline);
  }

  // Formatting, key order, and scripts that pnpm install never executes
  // should keep the existing dependency snapshot warm.
  writeManifest({
    devDependencies: { vitest: "1.0.0" },
    scripts: {
      test: "vitest run --reporter=dot",
      prepare: "node scripts/prepare-git-hooks.mjs",
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
    },
    name: "fixture",
  });
  expect(fingerprint()).toBe(baseline);

  // Repository-owned package metadata does not affect pnpm's install tree
  // or any audited install hook, so schema churn must stay warm.
  writeManifest({
    name: "fixture",
    openclaw: { schemaVersions: { agent: 17, state: 7 } },
    scripts: {
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
      prepare: "node scripts/prepare-git-hooks.mjs",
      test: "vitest run",
    },
    devDependencies: { vitest: "1.0.0" },
  });
  expect(fingerprint()).toBe(baseline);

  writeManifest({
    name: "fixture",
    scripts: {
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
      prepare: "node scripts/prepare-git-hooks.mjs",
      test: "vitest run",
    },
    devDependencies: { vitest: "2.0.0" },
  });
  expect(fingerprint()).not.toBe(baseline);

  writeManifest({
    name: "fixture",
    scripts: { postinstall: "node install-v2.mjs", test: "vitest run" },
    devDependencies: { vitest: "1.0.0" },
  });
  expect(() => fingerprint()).toThrow(/unaudited install lifecycle scripts in package\.json/);

  mkdirSync(path.join(root, "packages", "worker"), { recursive: true });
  writeManifest({
    name: "fixture",
    scripts: {
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
      prepare: "node scripts/prepare-git-hooks.mjs",
    },
    devDependencies: { vitest: "1.0.0" },
  });
  const workerManifest = path.join(root, "packages", "worker", "package.json");
  writeFileSync(
    workerManifest,
    `${JSON.stringify({ name: "worker", scripts: { prepare: "node build.mjs" } })}\n`,
  );
  execFileSync("git", ["add", "packages/worker/package.json"], { cwd: root });
  for (const lock of [
    frozenLock,
    frozenLock.replace("  packages/worker:", "# group\n  packages/worker:"),
  ]) {
    writeFileSync(path.join(root, "pnpm-lock.yaml"), lock);
    expect(() => fingerprint()).toThrow(
      /unaudited install lifecycle scripts in packages\/worker\/package\.json/,
    );
  }
  writeFileSync(path.join(root, "pnpm-lock.yaml"), frozenLock);
  writeFileSync(
    workerManifest,
    `${JSON.stringify({ name: "worker", scripts: { build: "node build.mjs" } })}\n`,
  );

  writeManifest({
    name: "fixture",
    scripts: {
      "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
      postinstall: "node scripts/postinstall-bundled-plugins.mjs",
      preinstall: "node scripts/preinstall-package-manager-warning.mjs",
      prepare: "node scripts/prepare-git-hooks.mjs",
      test: "vitest run",
    },
    devDependencies: { vitest: "1.0.0" },
  });
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
  expect(fingerprint()).not.toBe(baseline);
  expect(fingerprint(false)).not.toBe(baseline);
});

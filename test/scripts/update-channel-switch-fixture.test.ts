import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withDistArtifactOwnership } from "../../scripts/lib/dist-artifact-ownership.mts";
import { writePackageDistInventoryForPublish } from "../../scripts/lib/package-dist-inventory.ts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { completePendingPackageLifecycle } from "../../src/infra/package-lifecycle.js";
import { collectGitRuntimeErrors } from "../../src/infra/update-git-runtime.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const assertionScript = "scripts/e2e/lib/update-channel-switch/assertions.mjs";

it("binds the beta selector to the loopback candidate metadata and exact tarball", () => {
  const { file, write, json } = fixtureFiles(tempDirs.make("update-channel-beta-target-"));
  const registry = "http://127.0.0.1:12345";
  const version = "2026.11.15-beta.1";
  const schemaVersions = { state: 41, agent: 24 };
  const bytes = "synthetic candidate archive bytes";
  json("package.json", { version, openclaw: { schemaVersions } });
  write("candidate.tgz", bytes);
  const manifest = {
    name: "openclaw",
    version,
    openclaw: { schemaVersions },
    dist: {
      tarball: `${registry}/openclaw/-/candidate.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
  };
  const check = (metadata: typeof manifest | (typeof manifest)[]) =>
    spawnSync(
      testNodeExecPath,
      [assertionScript, "assert-beta-registry", file("candidate.tgz"), file(".")],
      {
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_REGISTRY: registry },
        input: JSON.stringify(metadata),
      },
    );
  const selected = check(manifest);
  expect(selected.status, selected.stderr).toBe(0);
  const selectedNpm12 = check([manifest]);
  expect(selectedNpm12.status, selectedNpm12.stderr).toBe(0);
  expect(check([manifest, manifest]).status).toBe(1);
  expect(
    check({ ...manifest, openclaw: { schemaVersions: { ...schemaVersions, state: 40 } } }).status,
  ).toBe(1);
  expect(check({ ...manifest, dist: { ...manifest.dist, integrity: "sha512-wrong" } }).status).toBe(
    1,
  );
  expect(
    check({
      ...manifest,
      dist: { ...manifest.dist, tarball: "https://registry.npmjs.org/candidate.tgz" },
    }).status,
  ).toBe(1);
});

it.each([
  { name: "already-current", patch: {}, status: 0 },
  { name: "pending activation", patch: { phase: "activating", status: "running" }, status: 1 },
  {
    name: "different version",
    patch: { target: { kind: "package", version: "2026.11.10-beta.3" } },
    status: 1,
  },
  {
    name: "failed maintenance",
    patch: { steps: [{ step: "plugins", status: "failed" }] },
    status: 1,
  },
])("checks the native beta channel receipt: $name", ({ patch, status }) => {
  const version = "2026.11.15-beta.1";
  const receipt = {
    phase: "finished",
    status: "skipped",
    reason: "already-current",
    before: { version },
    target: { kind: "package", version },
    repair: [],
    origin: {},
    steps: [
      { step: "requested", status: "completed" },
      { step: "staging", status: "skipped" },
      { step: "plugins", status: "completed" },
    ],
    ...patch,
  };
  const result = spawnSync(testNodeExecPath, [assertionScript, "assert-update", "beta", version], {
    encoding: "utf8",
    env: { ...process.env, UPDATE_JSON: JSON.stringify(receipt) },
  });
  expect(result.status, result.stderr).toBe(status);
});

it("preserves the package-derived Git fixture identity through build and lifecycle completion", async () => {
  const root = tempDirs.make("update-channel-git-fixture-");
  const { file, write, json } = fixtureFiles(root);
  const packageCommit = "a".repeat(40);
  const runtimeEntry = "export {};\n";
  json("package.json", { name: "openclaw", version: "2026.8.1", engines: { node: ">=22.22.3" } });
  write("dist/entry.js", runtimeEntry);
  json("dist/build-info.json", { commit: packageCommit, version: "2026.8.1" });
  execFileSync(testNodeExecPath, ["scripts/e2e/lib/package-git-fixture.mjs", "prepare", root]);
  execFileSync(testNodeExecPath, [assertionScript, "prepare-git-fixture", root]);
  mkdirSync(file("scripts/lib"), { recursive: true });
  for (const name of [
    "node-version.mjs",
    "scripts/preinstall-package-manager-warning.mjs",
    "scripts/postinstall-bundled-plugins.mjs",
    "scripts/lib/fs-safe-prebuild.mjs",
    "scripts/lib/fs-safe-npm-cli-preload.generated.mjs",
    "scripts/lib/fs-safe-npm-cli-protocol.mjs",
    "runtime-process-bootstrap.generated.mjs",
    "runtime-process-scripts.generated.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/package-lifecycle-marker.mjs",
  ]) {
    copyFileSync(name, file(name));
  }
  await writePackageDistInventoryForPublish(root);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const sha = git(["rev-parse", "HEAD"]);
  const manifest = JSON.parse(readFileSync(file("package.json"), "utf8")) as {
    scripts: { build: string };
  };
  const preflight = tempDirs.make("update-channel-preflight-");
  const home = tempDirs.make("update-channel-lifecycle-home-");
  execFileSync("git", ["clone", "--quiet", root, preflight]);
  for (const checkout of [preflight, root]) {
    const checked = fixtureFiles(checkout);
    const gitStatus = () =>
      execFileSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" });
    await withDistArtifactOwnership(checkout, async () => {
      expect(gitStatus()).toBe("");
    });
    expect(await collectGitRuntimeErrors({ root: checkout, sha })).not.toEqual([]);
    execSync(manifest.scripts.build, { cwd: checkout });
    expect(await collectGitRuntimeErrors({ root: checkout, sha })).toEqual([]);
    checked.write(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH, "pending\n");
    await completePendingPackageLifecycle({
      packageRoot: checkout,
      runScript: ({ relativePath }) => {
        execFileSync(testNodeExecPath, [join(checkout, relativePath)], {
          cwd: checkout,
          env: {
            ...process.env,
            HOME: home,
            OPENCLAW_HOME: home,
            OPENCLAW_STATE_DIR: join(home, "state"),
            OPENCLAW_CONFIG_PATH: join(home, "config.json"),
            STATE_DIRECTORY: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: undefined,
          },
        });
      },
    });
    expect({
      errors: await collectGitRuntimeErrors({ root: checkout, sha }),
      pending: existsSync(checked.file(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH)),
      build: JSON.parse(checked.read("dist/build-info.json")),
      entry: checked.read("dist/entry.js"),
      status: gitStatus(),
    }).toEqual({
      errors: [],
      pending: false,
      build: { commit: sha, version: "2026.8.1" },
      entry: runtimeEntry,
      status: "",
    });
  }
});

it("rejects retained runtime staging at the channel update success boundary", () => {
  const root = tempDirs.make("update-channel-staging-cleanup-");
  const assertCleanup = () =>
    spawnSync(testNodeExecPath, [assertionScript, "assert-runtime-staging-clean", root], {
      encoding: "utf8",
    });
  writeFileSync(join(root, "operator-update-notes.tmp"), "unrelated input");
  expect(assertCleanup().status).toBe(0);
  const staging = join(
    root,
    "packages",
    "nested",
    "node_modules.openclaw-update-00000000-0000-4000-8000-000000000000.tmp",
  );
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "previous"), "recoverable original");
  const result = assertCleanup();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("successful update retained runtime staging entries");
  expect(readFileSync(join(staging, "previous"), "utf8")).toBe("recoverable original");
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  buildInstallManifest,
  parseWorkspaceDependencyDirs,
  resolveNpmEnvironment,
  resolveRuntimePackEnvironment,
  resolveRuntimePackPlan,
  resolveWorkspaceInstallPlan,
  restoreRuntimePack,
  rewriteWorkspaceDependencyVersions,
  runPreparedRuntimePack,
} from "../../scripts/ocm-npm-workspace-deps.mts";
import { restorePrepackArtifacts } from "../../scripts/openclaw-postpack.mjs";
import { preparePackageChangelog } from "../../scripts/package-changelog.mjs";
import { preparePackageDocsMap } from "../../scripts/package-docs-map.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const adapterPath = fileURLToPath(
  new URL("../../scripts/ocm-npm-workspace-deps.mts", import.meta.url),
);
const packageDocsMapPath = fileURLToPath(
  new URL("../../scripts/package-docs-map.mjs", import.meta.url),
);
const postpackPath = fileURLToPath(new URL("../../scripts/openclaw-postpack.mjs", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimeProfile = { OPENCLAW_OCM_RUNTIME_BUILD_PROFILE: "sourcePerformance" };
const buildDate = () => new Date("2026-07-11T12:34:56.000Z");
const installFlags = ["--omit=dev", "--no-save", "--package-lock=false"];
const sourceChangelog = `# Changelog

## 2026.8.1
- Current release notes with enough detail for package validation.

## 2026.7.1
- Previous release notes with enough detail for package validation.
`;

function packageFixture(root: string, fields: Record<string, unknown>) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: "1.0.0", ...fields })}\n`);
}

function workspaceFixture(
  root: string,
  name: string,
  exported: string,
  dependencies?: Record<string, string>,
) {
  packageFixture(root, { name, main: "index.js", dependencies });
  writeFileSync(join(root, "index.js"), `export const ${exported} = true;\n`);
}

function runNode(root: string, file: string, ...args: string[]) {
  return execFileSync(process.execPath, [file, ...args], { cwd: root, stdio: "pipe" });
}

function changelogFixture(prefix: string) {
  const root = tempDirs.make(prefix);
  packageFixture(root, { name: "openclaw", version: "2026.8.1" });
  writeFileSync(join(root, "CHANGELOG.md"), sourceChangelog);
  return root;
}

it("allows Unreleased notes only for non-publishing pack commands", () => {
  const env = { KEEP: "value" };
  expect(resolveNpmEnvironment(["install"], env)).toBe(env);
  expect(resolveNpmEnvironment(["pack", "--silent"], env)).toEqual({
    KEEP: "value",
    OCM_INTERNAL_NPM_BIN: adapterPath,
    OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: "1",
  });
});

it("uses a prepared runtime-only pack for the diagnostic build profile", () => {
  expect(
    resolveRuntimePackPlan(["pack", "--pack-destination", "/tmp/out"], runtimeProfile),
  ).toEqual({
    profile: "sourcePerformance",
    packArgs: ["pack", "--pack-destination", "/tmp/out", "--ignore-scripts"],
  });
});

it("keeps normal package builds on the full prepack path", () => {
  expect(resolveRuntimePackPlan(["pack"], {})).toBeNull();
  expect(resolveRuntimePackPlan(["install"], runtimeProfile)).toBeNull();
});

it("rejects unsupported runtime build profiles", () => {
  expect(() =>
    resolveRuntimePackPlan(["pack"], {
      OPENCLAW_OCM_RUNTIME_BUILD_PROFILE: "qaRuntime",
    }),
  ).toThrow("invalid OPENCLAW_OCM_RUNTIME_BUILD_PROFILE: qaRuntime");
});

it("pins one timestamp and commit across the prepared runtime pack", () => {
  expect(
    resolveRuntimePackEnvironment(
      { KEEP: "value" },
      buildDate,
      () => "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    ),
  ).toMatchObject({
    KEEP: "value",
    GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
    OPENCLAW_BUILD_TIMESTAMP: "2026-07-11T12:34:56.000Z",
  });
});

it("rejects ambiguous runtime pack commits", () => {
  expect(() =>
    resolveRuntimePackEnvironment({ GITHUB_SHA: "abc123" }, buildDate, () => null),
  ).toThrow("runtime pack commit must be a full 40-character hexadecimal SHA");
});

it("does not let a failed concurrent owner restore the active pack lifecycle", async () => {
  const root = changelogFixture("openclaw-ocm-pack-owner-");
  const mapPath = join(root, "docs", "docs_map.md");
  const receiptPath = join(root, ".artifacts", "package-docs-map", "receipt.json");
  const changelogBackupPath = join(
    root,
    ".artifacts/package-changelog/CHANGELOG.md.prepack-backup",
  );
  const sourceMap = "# Docs map source\n";
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "page.md"), "# Package docs\n");
  writeFileSync(mapPath, sourceMap);
  await preparePackageDocsMap(root);
  await preparePackageChangelog(root);
  const activeMap = readFileSync(mapPath, "utf8");
  const activeChangelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  let packCalled = false;

  expect(() =>
    runPreparedRuntimePack(
      () => runNode(root, packageDocsMapPath, "prepare"),
      () => {
        packCalled = true;
        return 0;
      },
      () => runNode(root, postpackPath),
    ),
  ).toThrow();

  expect([
    packCalled,
    existsSync(receiptPath),
    existsSync(changelogBackupPath),
    readFileSync(mapPath, "utf8"),
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  ]).toEqual([false, true, true, activeMap, activeChangelog]);

  await restorePrepackArtifacts(root);
  expect(readFileSync(mapPath, "utf8")).toBe(sourceMap);
  expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
});

it("restores a prepared legacy source fixture through its changelog owner", () => {
  const root = changelogFixture("openclaw-ocm-historical-pack-");
  const scriptsDir = join(root, "scripts");
  mkdirSync(join(scriptsDir, "lib"), { recursive: true });
  for (const file of [
    "package-changelog.mjs",
    "lib/check-limits.mts",
    "lib/release-changelog.mjs",
    "lib/release-notes-compaction.mjs",
  ]) {
    writeFileSync(
      join(scriptsDir, file),
      readFileSync(new URL(`../../scripts/${file}`, import.meta.url)),
    );
  }
  runNode(root, "scripts/package-changelog.mjs", "prepare");
  expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).not.toBe(sourceChangelog);
  expect(existsSync(join(root, "scripts", "openclaw-postpack.mjs"))).toBe(false);

  restoreRuntimePack(process.env, root);

  expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
  expect(
    existsSync(join(root, ".artifacts", "package-changelog", "CHANGELOG.md.prepack-backup")),
  ).toBe(false);
});

it("resolves workspace package directories", () => {
  expect(
    parseWorkspaceDependencyDirs(["packages/ai", "extensions/example"].join(delimiter), "/repo"),
  ).toEqual(["/repo/packages/ai", "/repo/extensions/example"]);
});

it("replaces the root archive argument with a prepared install manifest", () => {
  const installArgs = ["install", "--prefix", "runtime", ...installFlags];
  expect(
    resolveWorkspaceInstallPlan([...installArgs, "openclaw.tgz"], ["/repo/packages/ai"], "/repo"),
  ).toEqual({
    installArgs,
    prefixDir: "/repo/runtime",
    rootArchive: "/repo/openclaw.tgz",
  });
});

it("keeps normal npm commands unchanged", () => {
  expect(resolveWorkspaceInstallPlan(["pack", "--silent"], ["/repo/packages/ai"])).toBeNull();
  expect(resolveWorkspaceInstallPlan(["install", "openclaw.tgz"], [])).toBeNull();
});

it("builds a manifest with the root and local workspace tarballs", () => {
  expect(
    buildInstallManifest("/tmp/openclaw.tgz", [
      { name: "@openclaw/ai", tarball: "/tmp/openclaw-ai.tgz" },
    ]),
  ).toEqual({
    private: true,
    dependencies: {
      "@openclaw/ai": "file:///tmp/openclaw-ai.tgz",
      openclaw: "file:///tmp/openclaw.tgz",
    },
  });
});

it("rewrites packed workspace protocols to the local package version", () => {
  const packageJson = { dependencies: { "@openclaw/ai": "workspace:*", chalk: "5.6.2" } };

  expect(
    rewriteWorkspaceDependencyVersions(packageJson, [
      { name: "@openclaw/ai", version: "2026.7.1-beta.3", tarball: "/tmp/openclaw-ai.tgz" },
    ]),
  ).toBe(1);
  expect(packageJson.dependencies).toEqual({
    "@openclaw/ai": "2026.7.1-beta.3",
    chalk: "5.6.2",
  });
});

it("rejects package archives with an unconfigured workspace dependency", () => {
  const packageJson = { dependencies: { "@openclaw/normalization-core": "workspace:*" } };

  expect(() => rewriteWorkspaceDependencyVersions(packageJson, [])).toThrow(
    "package archive references unconfigured workspace dependency: @openclaw/normalization-core",
  );
});

it("installs a packed root with transitive local workspace dependencies", () => {
  const root = tempDirs.make("openclaw-ocm-adapter-test-");
  const archiveRoot = join(root, "archive");
  const packagedRoot = join(archiveRoot, "package");
  const workspaceDir = join(root, "ai");
  const transitiveWorkspaceDir = join(root, "normalization-core");
  const installDir = join(root, "install");
  const rootArchive = join(root, "openclaw.tgz");
  packageFixture(packagedRoot, {
    name: "openclaw",
    dependencies: { "@openclaw/ai": "workspace:*" },
  });
  workspaceFixture(workspaceDir, "@openclaw/ai", "ready", {
    "@openclaw/normalization-core": "workspace:*",
  });
  workspaceFixture(transitiveWorkspaceDir, "@openclaw/normalization-core", "normalized");
  execFileSync("tar", ["-czf", rootArchive, "-C", archiveRoot, "package"]);

  execFileSync(
    process.execPath,
    [adapterPath, "install", "--prefix", installDir, ...installFlags, rootArchive],
    {
      env: {
        ...process.env,
        OPENCLAW_OCM_REAL_NPM_BIN: process.platform === "win32" ? "npm.cmd" : "npm",
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: [workspaceDir, transitiveWorkspaceDir].join(
          delimiter,
        ),
        npm_config_audit: "false",
        npm_config_cache: join(root, "npm-cache"),
        npm_config_fund: "false",
      },
      stdio: "pipe",
    },
  );

  const installed = (name: string) =>
    JSON.parse(readFileSync(join(installDir, "node_modules", name, "package.json"), "utf8"));
  for (const name of ["openclaw", "@openclaw/ai", "@openclaw/normalization-core"]) {
    expect(installed(name).version).toBe("1.0.0");
  }
  expect(installed("@openclaw/ai").dependencies["@openclaw/normalization-core"]).toBe("1.0.0");
});

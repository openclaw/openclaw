import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { create } from "tar";
import { writeCombinedBuildFixture } from "./prepublish-plugin-registry-build.fixture.js";

export const SOURCE_SHA = "a".repeat(40);
export const VERSION = "2026.8.1-beta.1";
const MANIFEST = "prepublish-plugin-registry.json";
export const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value)}\n`);
export const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const archives = new Map<string, Buffer>();

export function writeTarball(
  root: string,
  tarball: string,
  name: string,
  version = VERSION,
  extra: Record<string, unknown> = {},
) {
  const key = JSON.stringify({ ...extra, name, version });
  const cached = archives.get(key);
  if (cached) {
    writeFileSync(tarball, cached);
    return tarball;
  }
  const staging = join(root, "staging", basename(tarball));
  mkdirSync(join(staging, "package"), { recursive: true });
  writeJson(join(staging, "package/package.json"), { ...extra, name, version });
  // Native tar adds Darwin AppleDouble files, changing package entry counts.
  // Keep cached fixture bytes limited to the package contents on every host.
  create({ cwd: staging, file: tarball, gzip: true, sync: true }, ["package"]);
  // Cache original bytes only; every caller receives its own mutable file.
  archives.set(key, readFileSync(tarball));
  return tarball;
}

export function registryFixture(
  root: string,
  names: string[],
  version = VERSION,
  options: { versionedNames?: boolean; candidateMetadata?: boolean } = {},
) {
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
  const packages = names.map((name) => {
    const stem = name.replace(/^@/u, "").replace("/", "-");
    const tarball = `${stem}${options.versionedNames ? `-${version}` : ""}.tgz`;
    const extra = options.candidateMetadata
      ? {
          provenance: "candidate",
          ...(name === "openclaw" ? { dependencies: { "@openclaw/ai": version } } : {}),
        }
      : {};
    const file = writeTarball(root, join(artifactDir, tarball), name, version, extra);
    return { name, version, tarball, sha256: sha256(file) };
  });
  const manifestPath = join(artifactDir, MANIFEST);
  const manifest = {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    candidateVersion: version,
    packages,
  };
  const writeManifest = () => writeJson(manifestPath, manifest);
  writeManifest();
  return {
    artifactDir,
    manifest,
    manifestPath,
    tarballPath: join(artifactDir, packages[0]!.tarball),
    writeManifest,
    env: {
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: artifactDir,
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: SOURCE_SHA,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: version,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: sha256(manifestPath),
    },
  };
}

export function commitRegistrySource(repoRoot: string) {
  const fixtureCommitArgs = [
    "-c",
    "user.email=release-test@example.invalid",
    "-c",
    "user.name=Release Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "test: seed release source",
  ];
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", fixtureCommitArgs, { cwd: repoRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function createRegistrySource(
  repoRoot: string,
  packageNames: string[],
  combinedBuild = false,
) {
  const scriptsDir = join(repoRoot, "scripts", "lib");
  mkdirSync(scriptsDir, { recursive: true });
  writeJson(join(repoRoot, "package.json"), { name: "openclaw", version: VERSION });
  for (const name of packageNames) {
    const packageDir = join(repoRoot, "extensions", name.split("/")[1]!);
    mkdirSync(packageDir, { recursive: true });
    writeJson(join(packageDir, "package.json"), {
      name,
      version: VERSION,
      openclaw: { release: { publishToNpm: true } },
    });
  }
  writeFileSync(
    join(scriptsDir, "plugin-npm-runtime-build.mjs"),
    'import fs from "node:fs"; fs.writeFileSync(".build-fixture", "built"); console.log("runtime build stdout");\n',
  );
  writeFileSync(
    join(scriptsDir, "plugin-npm-package-manifest.mjs"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
const repoRoot = process.cwd();
const packageDir = process.argv[process.argv.indexOf("--run") + 1];
const outputDir = process.argv[process.argv.indexOf("--pack-destination") + 1];
const staging = join(repoRoot, ".pack-fixture");
fs.mkdirSync(join(staging, "package"), { recursive: true });
fs.copyFileSync(join(repoRoot, packageDir, "package.json"), join(staging, "package", "package.json"));
const pkg = JSON.parse(fs.readFileSync(join(staging, "package", "package.json"), "utf8"));
const tarball = pkg.name.slice(1).replace("/", "-") + "-" + pkg.version + ".tgz";
execFileSync("tar", ["-czf", join(outputDir, tarball), "-C", staging, "package"]);
console.log("package manifest stdout");
`,
  );
  if (combinedBuild) {
    writeCombinedBuildFixture(repoRoot, packageNames, VERSION);
  }
  execFileSync("git", ["init"], { cwd: repoRoot });
  return { repoRoot, sourceSha: commitRegistrySource(repoRoot) };
}

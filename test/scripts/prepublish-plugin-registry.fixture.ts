import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
  execFileSync("tar", ["-czf", tarball, "-C", staging, "package"]);
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

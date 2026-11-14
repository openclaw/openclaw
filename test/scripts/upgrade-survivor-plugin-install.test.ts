import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { packToArchive } from "../../src/plugins/test-helpers/archive-fixtures.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJson } from "./upgrade-survivor-io.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.11.5-beta.1";
const candidateVersion = "2026.11.5-beta.2";
const packageName = "@openclaw/discord";
const sourceSha = "a".repeat(40);

async function pluginFixture() {
  const root = tempDirs.make("upgrade-survivor-plugin-install-");
  const stateDir = join(root, "state");
  const artifactDir = join(root, "artifact");
  const pkgDir = join(root, "package");
  for (const dir of [join(stateDir, "plugins"), artifactDir, pkgDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const pack = async (outDir: string, packageVersion: string) => {
    writeJson(join(pkgDir, "package.json"), { name: packageName, version: packageVersion });
    return packToArchive({ pkgDir, outDir, outName: "discord.tgz" });
  };
  const published = await pack(root, version);
  const candidate = await pack(artifactDir, candidateVersion);
  const archive = readFileSync(published);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const integrity = `sha256-${Buffer.from(sha256, "hex").toString("base64")}`;
  const npmIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const manifestPath = join(artifactDir, "prepublish-plugin-registry.json");
  writeJson(manifestPath, {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha,
    candidateVersion,
    packages: [
      {
        name: packageName,
        version: candidateVersion,
        tarball: "discord.tgz",
        sha256: createHash("sha256").update(readFileSync(candidate)).digest("hex"),
      },
    ],
  });
  const installPath = join(stateDir, "extensions", "discord");
  mkdirSync(installPath, { recursive: true });
  writeJson(join(installPath, "package.json"), { name: packageName, version });
  const record = {
    source: "clawhub",
    spec: `clawhub:${packageName}@beta`,
    version,
    installPath,
    clawhubPackage: packageName,
    clawhubChannel: "official",
    artifactKind: "npm-pack",
    integrity,
    npmIntegrity,
    clawpackSha256: sha256,
  };
  return {
    record,
    stateDir,
    run: (install: Record<string, unknown>, expectedVersion = version, retained = published) => {
      writeJson(join(stateDir, "plugins", "installs.json"), {
        installRecords: { discord: install },
      });
      return spawnSync(
        resolveTestNodeExecPath(),
        [
          "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
          "assert-npm-plugin-install",
          "discord",
          packageName,
          expectedVersion,
          "0",
          "",
          "",
          "",
          retained,
          candidateVersion,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: artifactDir,
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: createHash("sha256")
              .update(readFileSync(manifestPath))
              .digest("hex"),
            OPENCLAW_DOCKER_E2E_SELECTED_SHA: sourceSha,
          },
        },
      );
    },
  };
}

it("accepts official ClawHub npm-pack records and retained published artifact digests", async () => {
  const { record, run } = await pluginFixture();
  for (const fields of [
    record,
    { ...record, npmIntegrity: undefined, clawpackSha256: undefined },
    { ...record, integrity: undefined, clawpackSha256: undefined },
    { ...record, integrity: undefined, npmIntegrity: undefined },
  ]) {
    const result = run(fields);
    expect(result.status, result.stderr).toBe(0);
  }
});

it("preserves npm install verification", async () => {
  const { record, stateDir, run } = await pluginFixture();
  const installPath = join(stateDir, "npm/projects/discord/node_modules/@openclaw/discord");
  mkdirSync(installPath, { recursive: true });
  writeJson(join(installPath, "package.json"), { name: packageName, version });
  const result = run({
    source: "npm",
    spec: `${packageName}@beta`,
    resolvedVersion: version,
    installPath,
    integrity: record.npmIntegrity,
  });
  expect(result.status, result.stderr).toBe(0);
});

it.each([
  { source: "unknown" },
  { source: "path" },
  { clawhubChannel: "community" },
  { artifactKind: "legacy-zip" },
])("rejects an unqualified install source: %j", async (change) => {
  const { record, run } = await pluginFixture();
  const result = run({ ...record, ...change });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("must be installed from npm or official ClawHub npm-pack");
});

it.each(["integrity", "npmIntegrity", "clawpackSha256"])(
  "rejects mismatched ClawHub artifact bytes in %s",
  async (field) => {
    const { record, run } = await pluginFixture();
    const result = run({ ...record, [field]: "wrong-artifact" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("discord plugin registry artifact integrity changed");
  },
);

it("does not treat a retained baseline companion as the candidate version or artifact", async () => {
  const { record, run } = await pluginFixture();
  const wrongVersion = run(record, candidateVersion);
  expect(wrongVersion.status, wrongVersion.stderr).toBe(1);
  expect(wrongVersion.stderr).toContain("discord plugin version changed");
  const wrongArtifact = run(record, version, "");
  expect(wrongArtifact.status, wrongArtifact.stderr).toBe(1);
  expect(wrongArtifact.stderr).toContain("discord plugin registry artifact integrity changed");
});

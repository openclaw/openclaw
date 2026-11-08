import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrepublishPluginRegistryArtifact } from "../../scripts/prepublish-plugin-registry-artifact.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  VERSION,
  commitRegistrySource,
  createRegistrySource,
  sha256,
  writeJson,
  writeTarball,
} from "./prepublish-plugin-registry.fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DISCORD = "@openclaw/discord";
const RUNTIME = "@openclaw/z-runtime";
const PACKAGES = [DISCORD, RUNTIME];
const SCRIPT = path.resolve("scripts/prepublish-plugin-registry-artifact.mjs");

function fixture() {
  const source = createRegistrySource(tempDirs.make("prepublish-cohort-source-"), PACKAGES);
  return {
    ...source,
    outputDir: path.join(tempDirs.make("prepublish-cohort-output-"), "artifact"),
    candidateVersion: VERSION,
    requiredPackages: PACKAGES,
  };
}

function writePolicy(repoRoot: string, text: string) {
  const policyDir = path.join(repoRoot, "src/plugins");
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(path.join(policyDir, "official-runtime-plugins.ts"), text);
}

function floorPolicy(floor: unknown) {
  return `type Candidate = { npmSpec: string; versionBoundToOpenClaw: boolean; minimumCompatibleVersion: unknown };
export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES: Candidate[] = ${JSON.stringify([{ npmSpec: RUNTIME, versionBoundToOpenClaw: true, minimumCompatibleVersion: floor }])};\n`;
}

function expectNoPublication(source: ReturnType<typeof fixture>) {
  for (const file of [source.outputDir, ".build-fixture", ".pack-fixture"]) {
    expect(existsSync(path.resolve(source.repoRoot, file)), file).toBe(false);
  }
}

describe("selected-source prepublish cohort admission", () => {
  it("rejects a later incompatible runtime through the real CLI before any build or output", () => {
    const source = fixture();
    writePolicy(source.repoRoot, floorPolicy("2026.8.2"));
    source.sourceSha = commitRegistrySource(source.repoRoot);
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "create",
        "--repo-root",
        source.repoRoot,
        "--artifact-dir",
        source.outputDir,
        "--source-sha",
        source.sourceSha,
        "--candidate-version",
        VERSION,
        "--required-packages-json",
        JSON.stringify(PACKAGES),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${RUNTIME} candidate ${VERSION}`);
    expect(result.stderr).toContain(`minimum 2026.8.2 at ${source.sourceSha}`);
    expect(result.stdout).toBe("");
    expectNoPublication(source);
  });

  it.each([VERSION, "2026.7.5"])("packages an exact or newer cohort against floor %s", (floor) => {
    const source = fixture();
    writePolicy(source.repoRoot, floorPolicy(floor));
    source.sourceSha = commitRegistrySource(source.repoRoot);
    const artifact = createPrepublishPluginRegistryArtifact(source);
    expect(artifact.manifest.sourceSha).toBe(source.sourceSha);
    expect(artifact.manifest.packages.map(({ name, version }) => ({ name, version }))).toEqual(
      PACKAGES.map((name) => ({ name, version: VERSION })),
    );
  });

  it.each(["floor", "packed identity"])(
    "validates prepared %s before copying any package",
    (failure) => {
      const source = fixture();
      writePolicy(source.repoRoot, floorPolicy(failure === "floor" ? "2026.8.2" : VERSION));
      source.sourceSha = commitRegistrySource(source.repoRoot);
      const preparedBundleDir = tempDirs.make("prepublish-cohort-prepared-");
      const entries = ["openclaw", RUNTIME].map((packageName, index) => {
        const tarballName = `prepared-${index}.tgz`;
        const file = path.join(preparedBundleDir, tarballName);
        writeTarball(
          preparedBundleDir,
          file,
          packageName,
          failure === "packed identity" && packageName === RUNTIME ? "2026.7.5" : VERSION,
        );
        return { packageName, packageVersion: VERSION, tarballName, tarballSha256: sha256(file) };
      });
      writeJson(path.join(preparedBundleDir, "package-bundle.json"), {
        schema: "openclaw.npm-package-bundle/v1",
        releaseSha: source.sourceSha,
        ...entries[0],
        corePackageTarballs: entries.slice(1),
        dependencyTarballs: [],
      });
      expect(() =>
        createPrepublishPluginRegistryArtifact({ ...source, preparedBundleDir }),
      ).toThrow(
        failure === "floor"
          ? `${RUNTIME} candidate ${VERSION}`
          : `tarball identity mismatch for ${RUNTIME}`,
      );
      expectNoPublication(source);
    },
  );

  it("checks every source identity before building an earlier package", () => {
    const source = fixture();
    writeJson(path.join(source.repoRoot, "extensions/z-runtime/package.json"), {
      name: RUNTIME,
      version: "2026.7.5",
      openclaw: { release: { publishToNpm: true } },
    });
    source.sourceSha = commitRegistrySource(source.repoRoot);
    expect(() => createPrepublishPluginRegistryArtifact(source)).toThrow(
      `${RUNTIME} version differs from the root package candidate`,
    );
    expectNoPublication(source);
  });

  it("does not apply an unrequested runtime floor to a different package", () => {
    const source = fixture();
    writePolicy(source.repoRoot, floorPolicy("2026.8.2"));
    source.sourceSha = commitRegistrySource(source.repoRoot);
    expect(
      createPrepublishPluginRegistryArtifact({
        ...source,
        requiredPackages: [DISCORD],
      }).manifest.packages.map(({ name }) => name),
    ).toEqual([DISCORD]);
  });

  it("rejects an unorderable candidate version when a selected runtime has a floor", () => {
    const source = fixture();
    writePolicy(source.repoRoot, floorPolicy(VERSION));
    for (const [file, name] of [
      ["package.json", "openclaw"],
      ["extensions/discord/package.json", DISCORD],
      ["extensions/z-runtime/package.json", RUNTIME],
    ] as const) {
      writeJson(path.join(source.repoRoot, file), {
        name,
        version: "invalid",
        openclaw: { release: { publishToNpm: true } },
      });
    }
    source.sourceSha = commitRegistrySource(source.repoRoot);
    expect(() =>
      createPrepublishPluginRegistryArtifact({
        ...source,
        candidateVersion: "invalid",
      }),
    ).toThrow(`${RUNTIME} candidate invalid`);
    expectNoPublication(source);
  });

  it("ignores an untracked policy in a historical selected tree", () => {
    const source = fixture();
    writePolicy(source.repoRoot, "throw new Error('untracked policy must not run');");
    expect(createPrepublishPluginRegistryArtifact(source).manifest.packages).toHaveLength(2);
  });

  it.each([
    floorPolicy("invalid"),
    floorPolicy(42),
    floorPolicy(" 2026.8.1-beta.1 "),
    "export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES = {};",
    "export const unrelated = [];",
    "import './missing-policy.ts';",
  ])("rejects an invalid tracked policy before publication (%#)", (policy) => {
    const source = fixture();
    writePolicy(source.repoRoot, policy);
    source.sourceSha = commitRegistrySource(source.repoRoot);
    expect(() => createPrepublishPluginRegistryArtifact(source)).toThrow();
    expectNoPublication(source);
  });

  it("retains dirty-source refusal before policy evaluation", () => {
    const source = fixture();
    writePolicy(source.repoRoot, floorPolicy(VERSION));
    source.sourceSha = commitRegistrySource(source.repoRoot);
    writePolicy(source.repoRoot, "throw new Error('dirty policy must not run');");
    expect(() => createPrepublishPluginRegistryArtifact(source)).toThrow(
      "repository has tracked changes",
    );
    expectNoPublication(source);
  });

  it("reloads the selected policy when the same checkout advances to a new revision", () => {
    const source = fixture();
    writePolicy(source.repoRoot, floorPolicy(VERSION));
    source.sourceSha = commitRegistrySource(source.repoRoot);
    expect(createPrepublishPluginRegistryArtifact(source).manifest.packages).toHaveLength(2);
    writePolicy(source.repoRoot, floorPolicy("2026.8.2"));
    source.sourceSha = commitRegistrySource(source.repoRoot);
    source.outputDir = path.join(tempDirs.make("prepublish-cohort-next-"), "artifact");
    expect(() => createPrepublishPluginRegistryArtifact(source)).toThrow("minimum 2026.8.2");
    expect(existsSync(source.outputDir)).toBe(false);
  });
});

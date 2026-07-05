// Plugin npm publication result tests close extended-stable matrix evidence.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectExtendedStablePublishablePluginPackages,
  deriveExtendedStablePluginCandidateTag,
} from "../../scripts/lib/plugin-npm-release.js";
import { buildExtendedStablePluginPublicationResult } from "../../scripts/plugin-npm-publication-result.js";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../helpers/temp-repo.js";

const identity = {
  repository: "openclaw/openclaw",
  workflowPath: ".github/workflows/plugin-npm-release.yml",
  workflowRef: "refs/heads/main",
  workflowSha: "b".repeat(40),
  runId: "123",
  runAttempt: "2",
};

const tempDirs: string[] = [];

function makeReleaseRoot(version: string): string {
  const rootDir = makeTempRepoRoot(tempDirs, "openclaw-publication-result-");
  writeJsonFile(join(rootDir, "package.json"), { version });
  mkdirSync(join(rootDir, "release"), { recursive: true });
  writeFileSync(
    join(rootDir, "release/extended-stable-plugin-support.json"),
    readFileSync("release/extended-stable-plugin-support.json", "utf8"),
  );
  for (const pluginId of ["codex", "discord", "matrix", "slack"]) {
    const packageDir = join(rootDir, "extensions", pluginId);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "README.md"), `# ${pluginId}\n`);
    writeJsonFile(join(packageDir, "package.json"), {
      name: `@openclaw/${pluginId}`,
      version,
      type: "module",
      repository: { type: "git", url: "https://github.com/openclaw/openclaw" },
      openclaw: {
        extensions: ["./index.ts"],
        install: { npmSpec: `@openclaw/${pluginId}` },
        compat: { pluginApi: `>=${version}` },
        build: { openclawVersion: version },
        release: { publishToNpm: true },
      },
    });
  }
  return rootDir;
}

function records(rootDir: string, version: string) {
  return collectExtendedStablePublishablePluginPackages(rootDir).map((plugin) =>
    Object.assign({}, identity, {
      packageName: plugin.packageName,
      version,
      npmIntegrity: `sha512-${plugin.extensionId}`,
      candidateTag: deriveExtendedStablePluginCandidateTag({
        pluginId: plugin.extensionId,
        version,
      }),
      provenanceVerified: true,
      sourceSha: "b".repeat(40),
    }),
  );
}

function snapshotReadbacks(version: string) {
  return [
    {
      packageName: "@openclaw/matrix",
      version: `${version.split(".").slice(0, 2).join(".")}.33`,
      npmIntegrity: "sha512-matrix",
      installVerified: true,
    },
  ];
}

describe("extended-stable plugin publication result", () => {
  it("sorts and closes every patch 33 publication plus snapshot readback", () => {
    const version = "2026.6.33";
    const rootDir = makeReleaseRoot(version);
    const result = buildExtendedStablePluginPublicationResult({
      rootDir,
      records: records(rootDir, version),
      snapshotReadbacks: snapshotReadbacks(version),
      sourceSha: "b".repeat(40),
      identity,
    });

    expect(result.plugins.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/codex",
      "@openclaw/discord",
      "@openclaw/matrix",
      "@openclaw/slack",
    ]);
    expect(result.schemaVersion).toBe(2);
    expect(result.snapshotReadbacks).toEqual(snapshotReadbacks(version));
    expect(result.workflow).toEqual(identity);
  });

  it("closes only covered publications after patch 33", () => {
    const version = "2026.6.34";
    const rootDir = makeReleaseRoot(version);
    const result = buildExtendedStablePluginPublicationResult({
      rootDir,
      records: records(rootDir, version),
      snapshotReadbacks: snapshotReadbacks(version),
      sourceSha: "b".repeat(40),
      identity,
    });

    expect(result.plugins.map((plugin) => plugin.packageName)).toEqual([
      "@openclaw/codex",
      "@openclaw/discord",
      "@openclaw/slack",
    ]);
  });

  it("rejects missing packages, wrong tags, and unverified provenance", () => {
    const version = "2026.6.34";
    const rootDir = makeReleaseRoot(version);
    const validRecords = records(rootDir, version);
    expect(() =>
      buildExtendedStablePluginPublicationResult({
        rootDir,
        records: validRecords.slice(1),
        snapshotReadbacks: snapshotReadbacks(version),
        sourceSha: "b".repeat(40),
        identity,
      }),
    ).toThrow(/must contain exactly/u);

    const wrongTag = records(rootDir, version);
    wrongTag[0] = { ...wrongTag[0], candidateTag: "extended-stable" };
    expect(() =>
      buildExtendedStablePluginPublicationResult({
        records: wrongTag,
        rootDir,
        snapshotReadbacks: snapshotReadbacks(version),
        sourceSha: "b".repeat(40),
        identity,
      }),
    ).toThrow(/candidate tag must be/u);

    const unverified = records(rootDir, version);
    unverified[0] = { ...unverified[0], provenanceVerified: false };
    expect(() =>
      buildExtendedStablePluginPublicationResult({
        records: unverified,
        rootDir,
        snapshotReadbacks: snapshotReadbacks(version),
        sourceSha: "b".repeat(40),
        identity,
      }),
    ).toThrow(/provenanceVerified must be true/u);
  });
});

afterAll(() => cleanupTempDirs(tempDirs));

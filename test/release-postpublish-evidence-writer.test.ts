import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJsonWithNewline,
  releasePolicySha256,
  sha256Hex,
  validatePostpublishEvidence,
} from "../scripts/lib/release-policy-evidence.mjs";
import { extractStableChangelogSection } from "../scripts/lib/stable-release-closeout.mjs";
import { buildReleasePostpublishEvidence } from "../scripts/write-release-postpublish-evidence.mjs";

const temporaryDirectories: string[] = [];
const sha = (value: string) => value.repeat(40).slice(0, 40);
const digest = (value: string) => value.repeat(64).slice(0, 64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSource() {
  const directory = mkdtempSync(join(tmpdir(), "release-postpublish-source-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, "CHANGELOG.md"),
    "# Changelog\n\n## 2026.7.1\n\n- Daily release.\n\n## 2026.6.34\n\n- Earlier.\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["add", "CHANGELOG.md"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
  return { directory, head };
}

function fixtures(sourceSha: string, sourceDir: string) {
  const releasePolicy = {
    version: 1,
    releaseVersion: "2026.7.1",
    releaseClass: "daily",
    releaseSelector: "daily",
    policyMode: "strict",
    publishEligible: true,
    authorizedSourceRef: "refs/heads/main",
    policySource: {
      sha: sha("a"),
      blobs: {
        releaseVersionPolicySha256: digest("b"),
        stableReleaseLinesModuleSha256: digest("c"),
        verifyReleaseOperationSha256: digest("d"),
        stableLinesSha256: null,
      },
    },
  };
  const section = extractStableChangelogSection(
    readFileSync(join(sourceDir, "CHANGELOG.md"), "utf8"),
    "2026.7.1",
  );
  if (section === null) {
    throw new Error("fixture changelog section missing");
  }
  const changelogEvidence = {
    tag: "v2026.7.1",
    sourceRef: "refs/heads/main",
    sectionHeading: "## 2026.7.1",
    sectionSha256: sha256Hex(section),
  };
  const publishManifest = {
    version: 1,
    releasePolicy,
    releasePolicySha256: releasePolicySha256(releasePolicy),
    preflight: { runId: "100", runAttempt: "1", payloadSha256: digest("e") },
    fullValidation: { runId: "101", runAttempt: "1", payloadSha256: digest("f") },
    execution: {
      event: "workflow_dispatch",
      workflowPath: ".github/workflows/openclaw-release-publish.yml",
      executionRef: "refs/heads/main",
      runHeadSha: sha("1"),
      runId: "102",
      runAttempt: "2",
    },
    target: {
      targetRef: "refs/tags/v2026.7.1",
      targetSha: sourceSha,
      releaseTag: "v2026.7.1",
      authorizedSourceRef: "refs/heads/main",
      authorizedSourceTipSha: sourceSha,
      targetReachableFromAuthorizedSource: true,
    },
    changelogEvidence,
  };
  const publishBytes = canonicalJsonWithNewline(publishManifest);
  const publishDescriptor = {
    runId: "102",
    runAttempt: "2",
    artifactName: "release-publish-manifest-102-2",
    payloadSha256: sha256Hex(publishBytes),
  };
  const registryResult = {
    version: 1,
    releaseVersion: "2026.7.1",
    releaseTag: "v2026.7.1",
    npmDistTag: "latest",
    pluginSelection: ["@openclaw/slack"],
    openclawNpmIntegrity: "sha512-integrity",
    openclawNpmTarball: "https://registry.example/openclaw.tgz",
    npmRegistrySignaturesVerified: true,
    npmProvenanceAttestationMatched: true,
    githubReleaseUrl: null,
    pluginNpmPackageCount: 1,
    clawHubPackageCount: 0,
    workflowRuns: [{ id: "1", label: "OpenClaw NPM Release", durationSeconds: 12 }],
  };
  return {
    releasePolicy,
    publishManifest,
    publishBytes,
    publishDescriptor,
    changelogEvidence,
    registryResult,
  };
}

describe("release postpublish evidence writer", () => {
  it("builds strict v2 evidence without mutating the registry result", () => {
    const source = createSource();
    const values = fixtures(source.head, source.directory);
    const evidence = buildReleasePostpublishEvidence({
      registryResult: values.registryResult,
      releasePolicy: values.releasePolicy,
      releasePolicySha256: releasePolicySha256(values.releasePolicy),
      publishManifest: values.publishManifest,
      publishDescriptor: values.publishDescriptor,
      publishPayloadSha256: sha256Hex(values.publishBytes),
      changelogEvidence: values.changelogEvidence,
      sourceDir: source.directory,
      sourceSha: source.head,
      releasePublishRunId: "102",
      releasePublishRunAttempt: "2",
    });
    expect(validatePostpublishEvidence(evidence)).toEqual(evidence);
    expect(evidence.version).toBe(2);
    expect(evidence.publishManifest).toEqual(values.publishDescriptor);
    expect(values.registryResult).not.toHaveProperty("releasePublishRunId");
  });

  it("rejects descriptor and changelog mismatches", () => {
    const source = createSource();
    const values = fixtures(source.head, source.directory);
    expect(() =>
      buildReleasePostpublishEvidence({
        registryResult: values.registryResult,
        releasePolicy: values.releasePolicy,
        releasePolicySha256: releasePolicySha256(values.releasePolicy),
        publishManifest: values.publishManifest,
        publishDescriptor: values.publishDescriptor,
        publishPayloadSha256: digest("0"),
        changelogEvidence: values.changelogEvidence,
        sourceDir: source.directory,
        sourceSha: source.head,
        releasePublishRunId: "102",
        releasePublishRunAttempt: "2",
      }),
    ).toThrow("publish descriptor payload digest mismatch");
  });

  it("rejects a registry dist-tag that does not match compatibility policy", () => {
    const source = createSource();
    const values = fixtures(source.head, source.directory);
    expect(() =>
      buildReleasePostpublishEvidence({
        registryResult: { ...values.registryResult, npmDistTag: "beta" },
        releasePolicy: values.releasePolicy,
        releasePolicySha256: releasePolicySha256(values.releasePolicy),
        publishManifest: values.publishManifest,
        publishDescriptor: values.publishDescriptor,
        publishPayloadSha256: sha256Hex(values.publishBytes),
        changelogEvidence: values.changelogEvidence,
        sourceDir: source.directory,
        sourceSha: source.head,
        releasePublishRunId: "102",
        releasePublishRunAttempt: "2",
      }),
    ).toThrow("registry result npmDistTag mismatch: expected latest, got beta");
  });

  it("writes from outside the source checkout and fails closed when dirty", () => {
    const source = createSource();
    const values = fixtures(source.head, source.directory);
    const inputDir = mkdtempSync(join(tmpdir(), "release-postpublish-input-"));
    temporaryDirectories.push(inputDir);
    const files = {
      registry: join(inputDir, "registry.json"),
      policy: join(inputDir, "policy.json"),
      publish: join(inputDir, "publish.json"),
      descriptor: join(inputDir, "descriptor.json"),
      changelog: join(inputDir, "changelog.json"),
      output: join(inputDir, "release-postpublish-evidence.json"),
    };
    for (const [path, value] of [
      [files.registry, values.registryResult],
      [files.policy, values.releasePolicy],
      [files.publish, values.publishManifest],
      [files.descriptor, values.publishDescriptor],
      [files.changelog, values.changelogEvidence],
    ] as const) {
      writeFileSync(path, canonicalJsonWithNewline(value));
    }
    const args = [
      join(process.cwd(), "scripts/write-release-postpublish-evidence.mjs"),
      "--registry-result",
      files.registry,
      "--release-policy",
      files.policy,
      "--release-policy-sha256",
      releasePolicySha256(values.releasePolicy),
      "--publish-manifest",
      files.publish,
      "--publish-descriptor",
      files.descriptor,
      "--changelog-evidence",
      files.changelog,
      "--source-dir",
      source.directory,
      "--source-sha",
      source.head,
      "--release-publish-run-id",
      "102",
      "--release-publish-run-attempt",
      "2",
      "--output",
      files.output,
    ];
    const result = spawnSync(process.execPath, args, { cwd: inputDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(
      validatePostpublishEvidence(JSON.parse(readFileSync(files.output, "utf8"))),
    ).toBeTruthy();

    writeFileSync(join(source.directory, "dirty.txt"), "dirty");
    const dirtyOutput = join(inputDir, "dirty-output.json");
    const dirtyResult = spawnSync(process.execPath, [...args.slice(0, -1), dirtyOutput], {
      cwd: inputDir,
      encoding: "utf8",
    });
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain("source checkout must be clean");
  });
});

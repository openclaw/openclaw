import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJsonWithNewline,
  releasePolicySha256,
  sha256Hex,
  validatePublishManifest,
} from "../scripts/lib/release-policy-evidence.mjs";
import { buildReleasePublishManifest } from "../scripts/write-release-publish-manifest.mjs";

const temporaryDirectories: string[] = [];
const sha = (value: string) => value.repeat(40).slice(0, 40);
const digest = (value: string) => value.repeat(64).slice(0, 64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtures() {
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
  const policyDigest = releasePolicySha256(releasePolicy);
  const preflightManifest = {
    version: 2,
    releaseTag: "v2026.7.1",
    releaseSha: sha("2"),
    npmDistTag: "latest",
    packageName: "openclaw",
    packageVersion: "2026.7.1",
    tarballName: "openclaw-2026.7.1.tgz",
    tarballSha256: digest("3"),
    dependencyEvidenceDir: "dependency-evidence",
    dependencyEvidenceManifest: "dependency-evidence/dependency-evidence-manifest.json",
    releasePolicy,
    releasePolicySha256: policyDigest,
  };
  const fullValidationManifest = {
    version: 3,
    workflowName: "Full Release Validation",
    runId: "101",
    runAttempt: "2",
    workflowRef: "refs/heads/main",
    targetRef: "refs/tags/v2026.7.1",
    targetSha: sha("2"),
    releaseProfile: "stable",
    rerunGroup: "release-2026.7.1",
    runReleaseSoak: "true",
    controls: { stableSoakRequired: true, performanceBlocking: true },
    childRuns: {
      normalCi: "1",
      pluginPrerelease: "2",
      releaseChecks: "3",
      npmTelegram: "4",
      productPerformance: { runId: "5", conclusion: "success", blocking: true },
    },
    releasePolicy,
    releasePolicySha256: policyDigest,
  };
  const execution = {
    event: "workflow_dispatch",
    workflowPath: ".github/workflows/openclaw-release-publish.yml",
    executionRef: "refs/heads/main",
    runHeadSha: sha("1"),
    runId: "102",
    runAttempt: "1",
  };
  const target = {
    targetRef: "refs/tags/v2026.7.1",
    targetSha: sha("2"),
    releaseTag: "v2026.7.1",
    authorizedSourceRef: "refs/heads/main",
    authorizedSourceTipSha: sha("2"),
    targetReachableFromAuthorizedSource: true,
  };
  const changelogEvidence = {
    tag: "v2026.7.1",
    sourceRef: "refs/heads/main",
    sectionHeading: "## 2026.7.1",
    sectionSha256: digest("4"),
  };
  const verificationResult = {
    schemaVersion: 1,
    ok: true,
    operation: "publish",
    releaseVersion: "2026.7.1",
    releaseClass: "daily",
    releaseSelector: "daily",
    policyMode: "strict",
    policySource: releasePolicy.policySource,
    execution,
    target,
  };
  const preflightBytes = canonicalJsonWithNewline(preflightManifest);
  const fullValidationBytes = canonicalJsonWithNewline(fullValidationManifest);
  return {
    releasePolicy,
    policyDigest,
    preflightManifest,
    preflightDescriptor: {
      runId: "100",
      runAttempt: "1",
      artifactName: "openclaw-npm-preflight-v2026.7.1",
      payloadSha256: sha256Hex(preflightBytes),
    },
    preflightBytes,
    fullValidationManifest,
    fullValidationDescriptor: {
      runId: "101",
      runAttempt: "2",
      artifactName: "full-release-validation-101",
      payloadSha256: sha256Hex(fullValidationBytes),
    },
    fullValidationBytes,
    verificationResult,
    changelogEvidence,
  };
}

describe("release publish manifest writer", () => {
  it("builds the closed manifest from authenticated predecessor identities", () => {
    const values = fixtures();
    const manifest = buildReleasePublishManifest({
      releasePolicy: values.releasePolicy,
      releasePolicySha256: values.policyDigest,
      preflightManifest: values.preflightManifest,
      preflightDescriptor: values.preflightDescriptor,
      preflightPayloadSha256: sha256Hex(values.preflightBytes),
      fullValidationManifest: values.fullValidationManifest,
      fullValidationDescriptor: values.fullValidationDescriptor,
      fullValidationPayloadSha256: sha256Hex(values.fullValidationBytes),
      verificationResult: values.verificationResult,
      changelogEvidence: values.changelogEvidence,
    });
    expect(validatePublishManifest(manifest)).toEqual(manifest);
    expect(manifest.preflight).toEqual({
      runId: "100",
      runAttempt: "1",
      payloadSha256: values.preflightDescriptor.payloadSha256,
    });
  });

  it("rejects policy-only and predecessor digest mismatches", () => {
    const values = fixtures();
    expect(() =>
      buildReleasePublishManifest({
        ...values,
        releasePolicySha256: values.policyDigest,
        preflightPayloadSha256: digest("0"),
        fullValidationPayloadSha256: sha256Hex(values.fullValidationBytes),
      }),
    ).toThrow("preflight descriptor payload digest mismatch");
    expect(() =>
      buildReleasePublishManifest({
        ...values,
        releasePolicy: { ...values.releasePolicy, publishEligible: false },
        releasePolicySha256: values.policyDigest,
        preflightPayloadSha256: sha256Hex(values.preflightBytes),
        fullValidationPayloadSha256: sha256Hex(values.fullValidationBytes),
      }),
    ).toThrow();
  });

  it("writes canonical bytes once and rejects collisions", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-publish-manifest-"));
    temporaryDirectories.push(directory);
    const values = fixtures();
    const files = {
      policy: join(directory, "policy.json"),
      preflight: join(directory, "preflight.json"),
      preflightDescriptor: join(directory, "preflight-descriptor.json"),
      full: join(directory, "full.json"),
      fullDescriptor: join(directory, "full-descriptor.json"),
      verification: join(directory, "verification.json"),
      changelog: join(directory, "changelog.json"),
      output: join(directory, "release-publish-manifest.json"),
    };
    for (const [path, value] of [
      [files.policy, values.releasePolicy],
      [files.preflight, values.preflightManifest],
      [files.preflightDescriptor, values.preflightDescriptor],
      [files.full, values.fullValidationManifest],
      [files.fullDescriptor, values.fullValidationDescriptor],
      [files.verification, values.verificationResult],
      [files.changelog, values.changelogEvidence],
    ] as const) {
      writeFileSync(path, canonicalJsonWithNewline(value));
    }
    const args = [
      "scripts/write-release-publish-manifest.mjs",
      "--release-policy",
      files.policy,
      "--release-policy-sha256",
      values.policyDigest,
      "--preflight-manifest",
      files.preflight,
      "--preflight-descriptor",
      files.preflightDescriptor,
      "--full-validation-manifest",
      files.full,
      "--full-validation-descriptor",
      files.fullDescriptor,
      "--verification-result",
      files.verification,
      "--changelog-evidence",
      files.changelog,
      "--output",
      files.output,
    ];
    const first = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    const bytes = readFileSync(files.output, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(canonicalJsonWithNewline(JSON.parse(bytes))).toBe(bytes);

    const second = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("EEXIST");
    expect(readFileSync(files.output, "utf8")).toBe(bytes);
  });
});

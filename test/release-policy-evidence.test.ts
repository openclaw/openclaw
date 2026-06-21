import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonWithNewline,
  releasePolicySha256,
  sha256Hex,
  validateArtifactDescriptor,
  validateChangelogEvidence,
  validateFullValidationManifest,
  validatePreflightManifest,
  validatePublishManifest,
  validateReleaseOperationResult,
  validateReleasePolicy,
} from "../scripts/lib/release-policy-evidence.mjs";

const sha = (value: string) => value.repeat(40).slice(0, 40);
const digest = (value: string) => value.repeat(64).slice(0, 64);

function dailyPolicy() {
  return {
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
}

function publishManifest() {
  const releasePolicy = dailyPolicy();
  return {
    version: 1,
    releasePolicy,
    releasePolicySha256: releasePolicySha256(releasePolicy),
    preflight: {
      runId: "100",
      runAttempt: "1",
      payloadSha256: digest("e"),
    },
    fullValidation: {
      runId: "101",
      runAttempt: "1",
      payloadSha256: digest("f"),
    },
    execution: {
      event: "workflow_dispatch",
      workflowPath: ".github/workflows/openclaw-release-publish.yml",
      executionRef: "refs/heads/main",
      runHeadSha: sha("1"),
      runId: "102",
      runAttempt: "1",
    },
    target: {
      targetRef: "refs/tags/v2026.7.1",
      targetSha: sha("2"),
      releaseTag: "v2026.7.1",
      authorizedSourceRef: "refs/heads/main",
      authorizedSourceTipSha: sha("2"),
      targetReachableFromAuthorizedSource: true,
    },
    changelogEvidence: {
      tag: "v2026.7.1",
      sourceRef: "refs/heads/main",
      sectionHeading: "## 2026.7.1",
      sectionSha256: digest("3"),
    },
  };
}

describe("canonicalJson", () => {
  it("sorts object keys recursively without changing array order", () => {
    const value = { z: 1, a: { z: 2, a: 3 }, list: [{ b: 1, a: 2 }, 3] };
    expect(canonicalJson(value)).toBe('{"a":{"a":3,"z":2},"list":[{"a":2,"b":1},3],"z":1}');
    expect(canonicalJsonWithNewline(value)).toBe(
      '{"a":{"a":3,"z":2},"list":[{"a":2,"b":1},3],"z":1}\n',
    );
  });

  it("rejects undefined and non-JSON values", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("JSON value");
    expect(() => canonicalJson(Number.NaN)).toThrow("finite");
  });
});

describe("release policy", () => {
  it("validates a closed strict daily policy and hashes bytes without a newline", () => {
    const policy = dailyPolicy();
    expect(validateReleasePolicy(policy)).toEqual(policy);
    expect(releasePolicySha256(policy)).toBe(sha256Hex(canonicalJson(policy)));
    expect(releasePolicySha256(policy)).not.toBe(sha256Hex(canonicalJsonWithNewline(policy)));
  });

  it("requires selector/mode and stable-lines digest invariants", () => {
    expect(() => validateReleasePolicy({ ...dailyPolicy(), releaseSelector: null })).toThrow(
      "releaseSelector",
    );
    expect(() =>
      validateReleasePolicy({
        ...dailyPolicy(),
        policySource: {
          ...dailyPolicy().policySource,
          blobs: { ...dailyPolicy().policySource.blobs, stableLinesSha256: digest("9") },
        },
      }),
    ).toThrow("stableLinesSha256");
  });

  it("rejects unknown fields recursively", () => {
    expect(() => validateReleasePolicy({ ...dailyPolicy(), extra: true })).toThrow("unknown field");
    expect(() =>
      validateReleasePolicy({
        ...dailyPolicy(),
        policySource: { ...dailyPolicy().policySource, extra: true },
      }),
    ).toThrow("unknown field");
  });

  it("accepts publishable strict stable policy for downstream artifact readers", () => {
    const policy = {
      ...dailyPolicy(),
      releaseVersion: "2026.6.33",
      releaseClass: "stable-base",
      releaseSelector: "stable",
      authorizedSourceRef: "refs/heads/stable/2026.6.33",
      policySource: {
        ...dailyPolicy().policySource,
        blobs: { ...dailyPolicy().policySource.blobs, stableLinesSha256: digest("9") },
      },
    };
    expect(validateReleasePolicy(policy)).toEqual(policy);
  });
});

describe("artifact contracts", () => {
  it("validates closed descriptors and changelog evidence", () => {
    expect(
      validateArtifactDescriptor({
        runId: "1",
        runAttempt: "2",
        artifactName: "release-publish-manifest-1-2",
        payloadSha256: digest("a"),
      }),
    ).toEqual({
      runId: "1",
      runAttempt: "2",
      artifactName: "release-publish-manifest-1-2",
      payloadSha256: digest("a"),
    });
    expect(
      validateChangelogEvidence({
        tag: "v2026.7.1",
        sourceRef: "refs/heads/main",
        sectionHeading: "## 2026.7.1",
        sectionSha256: digest("b"),
      }),
    ).toBeTruthy();
  });

  it("validates the recursively closed publish manifest", () => {
    expect(validatePublishManifest(publishManifest())).toEqual(publishManifest());
  });

  it("validates strict predecessor and verifier payloads", () => {
    const releasePolicy = dailyPolicy();
    const releasePolicyDigest = releasePolicySha256(releasePolicy);
    const preflight = {
      version: 2,
      releaseTag: "v2026.7.1",
      releaseSha: sha("2"),
      npmDistTag: "latest",
      packageName: "openclaw",
      packageVersion: "2026.7.1",
      tarballName: "openclaw-2026.7.1.tgz",
      tarballSha256: digest("4"),
      dependencyEvidenceDir: "dependency-evidence",
      dependencyEvidenceManifest: "dependency-evidence/dependency-evidence-manifest.json",
      releasePolicy,
      releasePolicySha256: releasePolicyDigest,
    };
    const fullValidation = {
      version: 3,
      workflowName: "Full Release Validation",
      runId: "101",
      runAttempt: "1",
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
      releasePolicySha256: releasePolicyDigest,
    };
    const verification = {
      schemaVersion: 1,
      ok: true,
      operation: "publish",
      releaseVersion: "2026.7.1",
      releaseClass: "daily",
      releaseSelector: "daily",
      policyMode: "strict",
      policySource: releasePolicy.policySource,
      execution: publishManifest().execution,
      target: publishManifest().target,
    };
    expect(validatePreflightManifest(preflight)).toEqual(preflight);
    expect(validateFullValidationManifest(fullValidation)).toEqual(fullValidation);
    expect(validateReleaseOperationResult(verification)).toEqual(verification);
  });

  it("rejects policy, target, and digest mismatches", () => {
    const manifest = publishManifest();
    expect(() =>
      validatePublishManifest({ ...manifest, releasePolicySha256: digest("0") }),
    ).toThrow("releasePolicySha256");
    expect(() =>
      validatePublishManifest({
        ...manifest,
        target: { ...manifest.target, releaseTag: "v2026.7.2" },
      }),
    ).toThrow("releaseTag");
    expect(() => validatePublishManifest({ ...manifest, extra: true })).toThrow("unknown field");
  });
});

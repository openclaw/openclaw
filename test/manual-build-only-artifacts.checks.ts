import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createReleasePublishInputs,
  resolveReleasePublishInputs,
} from "../scripts/lib/release-publish-inputs.mjs";
import {
  validateFullReleaseNpmPreflight,
  validateNpmPreflightProducer,
} from "../scripts/npm-preflight-tooling-identity.mjs";
import {
  describeNpmBundle,
  isBuildOnlyNpmPreflight,
  qualifyNpmPackageBundle,
  SEALED_NPM_PREFLIGHT_SCHEMA,
} from "../scripts/npm-prepared-bundle.mjs";
import { validateNpmPreflightDistTag } from "../scripts/openclaw-npm-extended-stable-release.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function artifactFixture() {
  const inputDir = roots.make("manual-build-only-input-");
  const outputDir = join(roots.make("manual-build-only-output-"), "sealed");
  const producer = {
    repository: "openclaw/openclaw",
    workflowRef: "openclaw/openclaw/.github/workflows/full-release-validation.yml@refs/heads/main",
    workflowSha: "b".repeat(40),
    runId: "12",
    runAttempt: "2",
    jobId: "45",
    jobName: "Prepare publishable npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const bytes = Buffer.from("exact prepared package bytes");
  const raw = {
    schema: "openclaw.npm-package-bundle/v1",
    producer,
    releaseTag: "v2026.11.9",
    releaseSha: "a".repeat(40),
    npmDistTag: "latest",
    packageName: "openclaw",
    packageVersion: "2026.11.9",
    tarballName: "openclaw-2026.11.9.tgz",
    tarballSha256: hash(bytes),
    corePackageTarballs: [],
    dependencyTarballs: [],
  };
  writeFileSync(join(inputDir, "package-bundle.json"), JSON.stringify(raw));
  writeFileSync(join(inputDir, raw.tarballName), bytes);
  const descriptor = describeNpmBundle({
    directory: inputDir,
    artifact: {
      id: "78",
      name: "openclaw-npm-package-12-2",
      digest: "c".repeat(64),
      runId: "12",
      runAttempt: "2",
    },
  });
  const options = {
    descriptor,
    inputDir,
    outputDir,
    producer: { ...producer, jobId: "50", jobName: "Qualify prepared npm package" },
  };
  return { options, bytes, raw };
}

it("seals exact build-only bytes without claiming SDK, source, dependency or content qualification", async () => {
  const f = artifactFixture();
  const runGh = vi.fn(() => {
    throw new Error("Build-only must not run validation proof acquisition");
  });
  const manifest = await qualifyNpmPackageBundle({
    ...f.options,
    validationMode: "build-only",
    runGh,
  });
  expect(runGh).not.toHaveBeenCalled();
  expect(readFileSync(join(f.options.outputDir, f.raw.tarballName))).toEqual(f.bytes);
  expect(manifest).toMatchObject({
    version: 4,
    validation: { mode: "build-only", skipped: ["source", "sdk", "dependencies", "contents"] },
  });
  expect(isBuildOnlyNpmPreflight(manifest)).toBe(true);
  expect(manifest).not.toHaveProperty("qualificationProofs");
  expect(manifest).not.toHaveProperty("pluginSdkApi");
  expect(existsSync(join(f.options.outputDir, "dependency-evidence"))).toBe(false);
  expect(
    describeNpmBundle({
      directory: f.options.outputDir,
      qualified: true,
      artifact: { ...f.options.descriptor.artifact, name: "openclaw-npm-preflight-v2026.11.9" },
    }).schema,
  ).toBe(SEALED_NPM_PREFLIGHT_SCHEMA);
  expect(() => validateNpmPreflightDistTag({ manifest, npmDistTag: "latest" })).not.toThrow();
  expect(() => validateNpmPreflightDistTag({ manifest, npmDistTag: "beta" })).toThrow();
});

it("keeps normal qualification strict and rejects corrupted or counterfeit build-only inputs", async () => {
  const f = artifactFixture();
  await expect(qualifyNpmPackageBundle(f.options)).rejects.toThrow();
  expect(existsSync(f.options.outputDir)).toBe(false);
  await expect(
    qualifyNpmPackageBundle({ ...f.options, validationMode: "build-only", sdkProof: {} }),
  ).rejects.toThrow("must not claim validation proofs");
  writeFileSync(join(f.options.inputDir, f.raw.tarballName), "tampered");
  await expect(
    qualifyNpmPackageBundle({ ...f.options, validationMode: "build-only" }),
  ).rejects.toThrow();
  expect(existsSync(f.options.outputDir)).toBe(false);
});

it("binds sealed artifacts to build-only full evidence and refuses ordinary or fake-proof producer bindings", async () => {
  const f = artifactFixture();
  const npmManifest = await qualifyNpmPackageBundle({ ...f.options, validationMode: "build-only" });
  const sealed = describeNpmBundle({
    directory: f.options.outputDir,
    qualified: true,
    artifact: { ...f.options.descriptor.artifact, name: "openclaw-npm-preflight-v2026.11.9" },
  });
  const manifest = {
    workflowName: "Full Release Validation",
    rerunGroup: "build-only",
    runId: "12",
    runAttempt: "2",
    targetSha: f.raw.releaseSha,
    workflowSha: f.options.producer.workflowSha,
    workflowFullRef: "refs/heads/main",
    publicationArtifacts: { npmPreflight: sealed },
  };
  const options = {
    manifest,
    repository: "openclaw/openclaw",
    runId: "12",
    runAttempt: "2",
    sourceSha: f.raw.releaseSha,
    toolingSha: f.options.producer.workflowSha,
  };
  expect(validateFullReleaseNpmPreflight(options)).toEqual(sealed);
  expect(() =>
    validateFullReleaseNpmPreflight({ ...options, manifest: { ...manifest, rerunGroup: "all" } }),
  ).toThrow();
  const producerOptions = {
    manifest: npmManifest,
    repository: "openclaw/openclaw",
    workflowFullRef: "refs/heads/main",
    workflowSha: f.options.producer.workflowSha,
    workflowPath: ".github/workflows/full-release-validation.yml",
    runId: "12",
    runAttempt: "2",
    fullReleaseManifest: manifest,
  };
  expect(() => validateNpmPreflightProducer(producerOptions)).not.toThrow();
  expect(() =>
    validateNpmPreflightProducer({ ...producerOptions, fullReleaseManifest: undefined }),
  ).toThrow();
  expect(() =>
    validateNpmPreflightProducer({
      ...producerOptions,
      manifest: { ...npmManifest, qualificationProofs: {} },
    }),
  ).toThrow();
});

it("records skipped SDK validation honestly and never accepts that absence for ordinary publishing", async () => {
  const f = artifactFixture();
  const npmManifest = await qualifyNpmPackageBundle({ ...f.options, validationMode: "build-only" });
  const manifest = {
    rerunGroup: "build-only",
    targetSha: f.raw.releaseSha,
    publicationArtifacts: {
      npmPreflight: { schema: SEALED_NPM_PREFLIGHT_SCHEMA, producer: f.options.producer },
    },
    sourceAdmission: {
      validationPurpose: "publish",
      publicationSelection: { npmDistTag: "latest" },
      projection: { packages: [] },
    },
  };
  const publishInputs = await createReleasePublishInputs({ manifest, npmManifest });
  expect(publishInputs.pluginSdkApiEvidenceDigest).toBeNull();
  expect(publishInputs.pluginSdkApiAcknowledgement).toBe("");
  expect(() => resolveReleasePublishInputs({ ...manifest, publishInputs })).not.toThrow();
  expect(() =>
    resolveReleasePublishInputs({ ...manifest, rerunGroup: "all", publishInputs }),
  ).toThrow();
  expect(() =>
    resolveReleasePublishInputs(
      { ...manifest, publishInputs },
      { pluginSdkApiAcknowledgement: "12345678" },
    ),
  ).toThrow();
  await expect(
    createReleasePublishInputs({ manifest: { ...manifest, rerunGroup: "all" }, npmManifest }),
  ).rejects.toThrow();
});

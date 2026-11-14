import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicationSelection } from "../../scripts/full-release-publication-contract.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { trustedMainNpmFixture } from "./release-ci-summary.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reads delayed piped run metadata before enforcing the CLI consumer boundary", async () => {
  const manifestPath = join(tempDirs.make("release-evidence-stdin-"), "manifest.json");
  writeFileSync(manifestPath, "{}");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/validate-full-release-validation-evidence.mjs", import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        MANIFEST_FILE: manifestPath,
        PUBLICATION_CONSUMER: "invalid-consumer",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  const stdout = text(child.stdout);
  const stderr = text(child.stderr);
  const inputErrors: Error[] = [];
  child.stdin.on("error", (error) => inputErrors.push(error));
  try {
    child.stdin.write('{"id":');
    // Model gh api delivering a later chunk while the nonblocking pipe stays open.
    await delay(250);
    child.stdin.end("123}");
    const [code] = await exited;
    expect(await stderr).toBe("Unknown publication evidence consumer.\n");
    expect(code).toBe(1);
    expect(await stdout).toBe("");
    expect(inputErrors).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
});

function publicationOptions(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    run: f.parent,
    expectedRepository: f.repository,
    expectedRunId: f.runId,
    expectedRunAttempt: 1,
    expectedTargetSha: f.q,
    expectedReleaseTag: "v2026.8.28-beta.1",
    expectedTrustedWorkflowFullRef: f.publisherFullRef,
    expectedTrustedWorkflowSha: f.p,
    expectedPublicationSelection: {
      route: "normal",
      npmDistTag: "beta",
      publishOpenclawNpm: true,
      pluginPublishScope: "all-publishable",
      plugins: [],
    } satisfies PublicationSelection,
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
}

describe("authenticated publication eligibility", () => {
  it("does not carry historical main evidence into a different publisher trust context", async () => {
    const f = trustedMainNpmFixture();
    // Match the retained JSON transport: omitted fields are not undefined properties.
    const manifestJson = JSON.stringify(f.manifest);
    const manifest = JSON.parse(manifestJson);
    const client = { ...f.client, loadManifest: () => ({ artifact: f.artifact, manifest }) };
    const options = {
      run: f.parentRun,
      manifest,
      expectedRepository: "openclaw/openclaw",
      expectedRunId: f.runId,
      expectedRunAttempt: 1,
      expectedTargetSha: f.targetSha,
      expectedReleaseTag: "v2026.8.28-beta.1",
      verifierSourceSha: f.workflowSha,
      verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
    };
    const authenticated = await authenticateFullReleaseValidationEvidence(options, client);
    const protectedContext = {
      ...options,
      expectedTrustedWorkflowFullRef: `refs/tags/release-publish/${f.workflowSha.slice(0, 12)}-123`,
      expectedTrustedWorkflowSha: f.workflowSha,
    };
    expect(() => authenticated.forPublication(protectedContext)).toThrow("tooling context differs");
    await expect(
      authenticateFullReleaseValidationEvidence(protectedContext, client),
    ).rejects.toThrow("protected-tag release evidence must use a canonical release-ci branch");
  });
  it("accepts the exact selection and rejects a different route or release tag at handoff", async () => {
    const f = candidatePublicationFixture();
    const options = publicationOptions(f);
    const authenticated = await authenticateFullReleaseValidationEvidence(options, f.client);
    expect(authenticated.qualification).toMatchObject({
      kind: "direct",
      candidateSha: f.q,
      qualificationSha: f.q,
      coveragePolicy: "npm-beta-v1",
    });
    expect(authenticated.forPublication(options).source).toBe("candidate-owned-admission-v1");
    expect(() =>
      authenticated.forPublication({ ...options, expectedReleaseTag: "v2026.8.28-beta.2" }),
    ).toThrow("exact publication tag");
    expect(() =>
      authenticated.forPublication({
        ...options,
        expectedPublicationSelection: {
          ...options.expectedPublicationSelection,
          route: "prepared",
        },
      }),
    ).toThrow("differently selected evidence");
  });

  it("covers the actual core npm operation only on its admitted dist-tag", async () => {
    const f = candidatePublicationFixture();
    const options = {
      ...publicationOptions(f),
      expectedPublicationSelection: undefined,
      expectedCoreNpmPublication: { npmDistTag: "beta" },
    };
    const authenticated = await authenticateFullReleaseValidationEvidence(options, f.client);
    expect(authenticated.source).toBe("candidate-owned-admission-v1");
    expect(() =>
      authenticated.forPublication({
        ...options,
        expectedCoreNpmPublication: { npmDistTag: "latest" },
      }),
    ).toThrow("actual core npm operation");
    expect(() =>
      authenticated.forPublication({
        ...options,
        expectedPublicationSelection: publicationOptions(f).expectedPublicationSelection,
      }),
    ).toThrow("one actual consumption selection");
  });

  it("rejects plugin subsets outside the admitted package roster", async () => {
    const f = candidatePublicationFixture();
    const options = publicationOptions(f);
    const authenticated = await authenticateFullReleaseValidationEvidence(options, f.client);
    for (const plugins of [["@openclaw/uncovered"], ["openclaw"], []]) {
      expect(() =>
        authenticated.forPublication({
          ...options,
          expectedPublicationSelection: undefined,
          expectedPublicationOperation: {
            ...options.expectedPublicationSelection,
            publishOpenclawNpm: false,
            pluginPublishScope: "selected",
            plugins,
          },
        }),
      ).toThrow("covered plugin-only subset");
    }
    expect(
      authenticated.forPublication({
        ...options,
        expectedPublicationSelection: undefined,
        expectedPublicationOperation: options.expectedPublicationSelection,
      }).source,
    ).toBe("candidate-owned-admission-v1");
  });

  it("requires separately admitted Windows selection instead of silently expanding publication", async () => {
    const f = candidatePublicationFixture();
    const options = publicationOptions(f);
    const authenticated = await authenticateFullReleaseValidationEvidence(options, f.client);
    expect(() =>
      authenticated.forPublication({
        ...options,
        expectedPublicationSelection: {
          ...options.expectedPublicationSelection,
          windowsNodeTag: "v0.6.3",
          windowsNodeInstallerDigests: {
            "OpenClawCompanion-Setup-x64.exe": `sha256:${"d".repeat(64)}`,
          },
        },
      }),
    ).toThrow("windows-node-release.yml");
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateDockerReleaseManifest,
  verifyDockerReleaseProducer,
} from "../../scripts/docker-release-artifacts.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  composeReleaseAttemptJobs,
  releaseExecutionPlanSha256,
  validateReleaseExecutionPlanArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { buildReleaseValidationManifest } from "../../scripts/lib/full-release-manifest.mjs";
import { evaluateReleaseChildPolicy } from "../../scripts/lib/release-validation-waivers.mjs";
import {
  downloadFullReleaseNpmPreflight,
  verifyNpmPreflightProducer,
  verifyNpmPreflightPublicationLineage,
} from "../../scripts/npm-preflight-tooling-identity.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { verifyQualificationAdmission } from "../../scripts/release-qualification-admission.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { fixture as admissionFixture } from "./release-qualification-admission.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function consumers(
  f: ReturnType<typeof candidatePublicationFixture>,
  evidenceClient: Parameters<typeof validateReleaseRunEvidence>[1] = f.client,
) {
  return {
    npm: () =>
      verifyNpmPreflightPublicationLineage({
        manifest: f.manifest,
        repository: f.repository,
        sourceSha: f.c,
        toolingSha: f.q,
        publisherSha: f.p,
        publisherFullRef: f.publisherFullRef,
        producerRunId: f.runId,
        producerRunAttempt: "1",
        runGh: f.runGh,
        evidenceClient,
      }),
    docker: () =>
      verifyDockerReleaseProducer(f.docker, {
        publisherSha: f.p,
        publisherFullRef: f.publisherFullRef,
        fullReleaseManifest: f.manifest,
        readApi: f.readApi,
        evidenceClient,
      }),
  };
}

function verifier(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    repository: f.repository,
    runId: f.runId,
    trustedWorkflowRef: f.publisherFullRef.slice("refs/tags/".length),
    trustedWorkflowFullRef: f.publisherFullRef,
    trustedWorkflowSha: f.p,
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
}

function publicationEvidenceOptions(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    run: f.parent,
    manifest: f.manifest,
    expectedRepository: f.repository,
    expectedRunId: f.runId,
    expectedRunAttempt: 1,
    expectedTargetSha: f.q,
    expectedReleaseTag: "v2026.8.28-beta.1",
    expectedTrustedWorkflowFullRef: f.publisherFullRef,
    expectedTrustedWorkflowSha: f.p,
    expectedCoreNpmPublication: { npmDistTag: "beta" },
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
}

function npmProducer(f: ReturnType<typeof candidatePublicationFixture>) {
  return verifyNpmPreflightProducer({
    manifest: f.npmManifest,
    manifestSha256: sha256(f.npmManifestBytes),
    repository: f.repository,
    workflowFullRef: f.tooling.fullRef,
    workflowSha: f.q,
    workflowPath: ".github/workflows/full-release-validation.yml",
    runId: f.runId,
    runAttempt: "1",
    fullReleaseManifest: f.manifest,
    fullReleaseRunId: f.runId,
    fullReleaseRunAttempt: "1",
    runGh: f.runGh,
  });
}

describe("candidate-owned publish consumer chain", () => {
  it("rejects missing Q ledger evidence without using a fallback policy", async () => {
    const f = candidatePublicationFixture();
    const client = {
      ...f.client,
      getWorkflowSource: (sha: string, path?: string) => {
        if (path === "scripts/lib/release-validation-waivers.json") {
          throw new Error("gh: Not Found (HTTP 404)");
        }
        return f.client.getWorkflowSource(sha, path);
      },
    };
    await expect(validateReleaseRunEvidence(verifier(f), client)).rejects.toThrow("HTTP 404");
  });
  it("retains an empty waiver record when a frozen Q named job passed", async () => {
    const version = "2099.1.1-beta.1";
    const f = candidatePublicationFixture({ candidateVersion: version });
    const client = {
      ...f.client,
      getWorkflowSource: (sha: string, path?: string) =>
        path === "scripts/lib/release-validation-waivers.json"
          ? JSON.stringify({
              schema: "openclaw.release-validation-waivers/v1",
              waivers: [
                {
                  targetVersion: version,
                  childRole: "pluginPrereleaseCandidate",
                  jobName: "plugin-prerelease-suite",
                  reason: "Synthetic historical approval",
                  aggregates: [],
                },
              ],
            })
          : f.client.getWorkflowSource(sha, path),
    };
    await expect(validateReleaseRunEvidence(verifier(f), client)).resolves.toMatchObject({
      waivers: [],
    });
  });

  it("evaluates raw failed evidence against Q data rather than the verifier checkout", async () => {
    const f = candidatePublicationFixture({
      candidateVersion: "2099.1.1-beta.1",
      qualificationSha: "c".repeat(40),
    });
    const selected = f.plan.children.find((child) => child.key === "normalCi");
    assert(selected);
    const originalJobs = await f.client.getRunAttemptJobs(selected.runId);
    const gate = originalJobs.find((job) => job.name === "openclaw/ci-gate");
    assert(gate);
    const jobs = [
      ...originalJobs,
      { ...gate, id: 1598, name: "synthetic leaf", conclusion: "failure" },
    ];
    const policy = [
      {
        targetVersion: "2099.1.1-beta.1",
        targetSha: f.c,
        childRole: "normalCi",
        jobName: "synthetic leaf",
        reason: "Synthetic approval",
      },
    ];
    const composite = composeReleaseAttemptJobs([{ jobs, runAttempt: 1 }], {
      effectiveRunAttempt: 1,
      plannedRunAttempt: 1,
    });
    assert(f.manifest.childEvidence.normalCi);
    Object.assign(f.manifest.childEvidence.normalCi, {
      jobs: composite.jobs,
      compositeJobsSha256: composite.sha256,
    });
    Object.assign(f.manifest, {
      waivers: evaluateReleaseChildPolicy({
        child: { key: "normalCi", jobs },
        targetVersion: "2099.1.1-beta.1",
        targetSha: f.c,
        waiverPolicy: policy,
      }).waivers.map((waiver) =>
        Object.assign({}, waiver, { runId: selected.runId, runAttempt: 1 }),
      ),
    });
    let grants = policy;
    const client = {
      ...f.client,
      getWorkflowSource: (sha: string, path?: string) => {
        if (path === "scripts/lib/release-validation-waivers.json") {
          expect(sha).toBe(f.q);
          return JSON.stringify({
            schema: "openclaw.release-validation-waivers/v1",
            waivers: grants,
          });
        }
        return f.client.getWorkflowSource(sha, path);
      },
      getRunAttemptJobs: async (id: string) =>
        id === selected.runId
          ? [
              ...originalJobs,
              {
                ...jobs.at(-1)!,
                steps: [{ name: "Run workload", status: "completed", conclusion: "failure" }],
              },
            ]
          : f.client.getRunAttemptJobs(id),
      getRun: async (id: string) => ({
        ...(await f.client.getRun(id)),
        ...(id === selected.runId ? { conclusion: "failure" } : {}),
      }),
    };
    const before = JSON.stringify(f.manifest.childEvidence);
    await expect(validateReleaseRunEvidence(verifier(f), client)).resolves.toMatchObject({
      waivers: [expect.objectContaining({ jobName: "synthetic leaf" })],
    });
    expect(JSON.stringify(f.manifest.childEvidence)).toBe(before);
    grants = [];
    await expect(validateReleaseRunEvidence(verifier(f), client)).rejects.toThrow(
      "does not pass release policy",
    );
  });
  it("authenticates a never-dispatched required child only with a pinned-Q parent waiver", async () => {
    const version = "2099.1.1-beta.1";
    const f = candidatePublicationFixture({ candidateVersion: version });
    const childRole = "normalCi";
    const planned = f.plan.children.find((child) => child.key === childRole);
    assert(planned);
    Object.assign(planned, { result: "skipped", runId: "", runAttempt: null, url: "" });
    f.plan.sha256 = releaseExecutionPlanSha256(f.plan);
    f.manifest.executionPlanSha256 = f.plan.sha256;
    f.manifest.childRuns.normalCi = "";
    Reflect.deleteProperty(f.manifest.childEvidence, childRole);
    const grant = {
      targetVersion: version,
      targetSha: f.c,
      childRole,
      reason: "Synthetic missing dispatch",
    };
    let waivers = [grant];
    const recorded = { ...grant, runId: "", runAttempt: null };
    Object.assign(f.manifest, { waivers: [recorded] });
    const client = {
      ...f.client,
      getWorkflowSource: (sha: string, path?: string) =>
        path === "scripts/lib/release-validation-waivers.json"
          ? JSON.stringify({ schema: "openclaw.release-validation-waivers/v1", waivers })
          : f.client.getWorkflowSource(sha, path),
    };
    const result = await validateReleaseRunEvidence(verifier(f), client);
    expect(result).toMatchObject({
      conclusions: { children: { normalCi: "missing" } },
      waivers: [recorded],
    });
    expect(result.children.map(({ role }) => role)).not.toContain(childRole);
    waivers = [];
    await expect(validateReleaseRunEvidence(verifier(f), client)).rejects.toThrow(
      "execution plan omits required child",
    );
  });

  it("verifies independent Q through the immutable plan, npm and Docker consumers", async () => {
    const f = candidatePublicationFixture({ qualificationSha: "c".repeat(40) });
    const evidence = await validateReleaseRunEvidence(verifier(f), f.client);
    expect(evidence.manifest.targetSha).toBe(f.c);
    expect(evidence.manifest.workflowSha).toBe(f.q);
    expect(f.c).not.toBe(f.q);
    await expect(consumers(f).npm()).resolves.toBeDefined();
    await expect(consumers(f).docker()).resolves.toBeDefined();
  });
  it.each([
    "beta promotion descendant",
    "beta promotion waived descendant",
    "beta promotion execution-plan descendant",
    "same qualification",
    "preflight-first current same qualification",
    "preflight-first root same qualification",
    "beta promotion preflight-first descendant",
    "candidate-bound same qualification",
    "candidate-bound changelog descendant",
    "candidate-bound execution-plan descendant",
    "changelog descendant",
    "execution-plan descendant",
    "independent Q change on changelog descendant",
    "changed candidate",
    "changed input",
    "changed P",
    "revoked P",
  ])("selects a direct admitted root across transport refs only for %s", async (scenario) => {
    const promotion = scenario.startsWith("beta promotion");
    const candidateBound = scenario.startsWith("candidate-bound");
    const versionBound = scenario.includes("waived");
    const version = "2099.1.1-beta.1";
    const changedPaths = promotion
      ? ["package.json", "extensions/discord/package.json", "docs/plugins/plugin-inventory.md"]
      : [`CHANGELOG/${version.split("-")[0]}.md`, `CHANGELOG/records/${version.split("-")[0]}.md`];
    const root = candidatePublicationFixture({
      candidateVersion: version,
      preflightFirst: scenario.includes("preflight-first root"),
      ...(promotion ? { releaseProfile: "stable", reuseEvidence: false } : {}),
      ...(candidateBound ? { candidateSha: "a".repeat(40) } : {}),
    });
    let evidenceClient: Parameters<typeof validateReleaseRunEvidence>[1] = root.client;
    if (candidateBound || versionBound) {
      const child = root.plan.children.find((entry) => entry.key === "normalCi");
      assert(child);
      const originalJobs = await root.client.getRunAttemptJobs(child.runId);
      const gate = originalJobs.find((job) => job.name === "openclaw/ci-gate");
      assert(gate);
      const jobs = [
        ...originalJobs,
        { ...gate, id: 1501, name: "synthetic leaf", conclusion: "failure" },
      ];
      const grants = [
        {
          targetVersion: version,
          ...(candidateBound ? { targetSha: root.q } : {}),
          childRole: "normalCi",
          jobName: "synthetic leaf",
          reason: "Synthetic candidate-bound approval",
        },
      ];
      const composite = composeReleaseAttemptJobs([{ jobs, runAttempt: 1 }], {
        effectiveRunAttempt: 1,
        plannedRunAttempt: 1,
      });
      assert(root.manifest.childEvidence.normalCi);
      Object.assign(root.manifest.childEvidence.normalCi, {
        jobs: composite.jobs,
        compositeJobsSha256: composite.sha256,
      });
      Object.assign(root.manifest, {
        waivers: evaluateReleaseChildPolicy({
          child: { key: "normalCi", jobs },
          targetVersion: version,
          targetSha: root.q,
          waiverPolicy: grants,
        }).waivers.map((waiver) =>
          Object.assign({}, waiver, { runId: child.runId, runAttempt: 1 }),
        ),
      });
      const original = { ...root.client };
      evidenceClient = {
        ...original,
        getRunAttemptJobs: async (id: string) =>
          id === child.runId ? jobs : original.getRunAttemptJobs(id),
        getRun: async (id: string) => ({
          ...(await original.getRun(id)),
          ...(id === child.runId ? { conclusion: "failure" } : {}),
        }),
        getWorkflowSource: (sha: string, path?: string) =>
          path === "scripts/lib/release-validation-waivers.json"
            ? JSON.stringify({ schema: "openclaw.release-validation-waivers/v1", waivers: grants })
            : original.getWorkflowSource(sha, path),
      };
    }
    const descendant = scenario.endsWith("descendant");
    const candidateSha = scenario === "changed candidate" || descendant ? "d".repeat(40) : root.q;
    const targetSha = descendant ? "d".repeat(40) : root.q;
    const qualificationSha =
      scenario === "independent Q change on changelog descendant" ? "f".repeat(40) : candidateSha;
    const workflowRef = "release-ci/" + qualificationSha.slice(0, 12) + "-456";
    const inputs = structuredClone(root.plan.qualificationInputs);
    inputs.ref = candidateSha;
    inputs.expected_sha = candidateSha;
    if (scenario === "changed input") {
      inputs.fail_fast = inputs.fail_fast === "true" ? "false" : "true";
    }
    assert(inputs.trusted_workflow_json);
    const envelope = JSON.parse(inputs.trusted_workflow_json);
    if (scenario.includes("preflight-first root")) {
      delete envelope.laneInputs.preflight_first;
    } else if (scenario.includes("preflight-first")) {
      envelope.laneInputs.preflight_first = "true";
    }
    envelope.trustedWorkflow = {
      ref: workflowRef,
      fullRef: "refs/heads/" + workflowRef,
      sha: qualificationSha,
    };
    if (promotion) {
      inputs.reuse_evidence = "true";
      envelope.publicationSelection.npmDistTag = "latest";
    }
    inputs.trusted_workflow_json = JSON.stringify(envelope);
    const current = admissionFixture(true, {
      inputs,
      candidateSha,
      qualificationSha,
      transportRef: workflowRef,
      candidateVersion: promotion ? "2099.1.1" : version,
      policy: JSON.parse(readFileSync("scripts/lib/release-qualification-coverage.json", "utf8")),
      workflowSource: readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
      baselinePolicySource: readFileSync("scripts/lib/upgrade-survivor-scenarios.json", "utf8"),
    });
    envelope.qualificationAdmission = current.descriptor;
    inputs.trusted_workflow_json = JSON.stringify(envelope);
    if (scenario === "revoked P") {
      current.authority.permission = "read";
    }
    const client = {
      ...evidenceClient,
      getSourceFile: (sha: string) =>
        JSON.stringify({ name: "openclaw", version: sha === root.c ? version : "2099.1.1" }),
      compareCommits: descendant
        ? () => ({
            status: "ahead",
            merge_base_commit: { sha: root.q },
            files: changedPaths.map((filename) => ({ filename, status: "modified" })),
          })
        : root.client.compareCommits,
      verifyQualificationAdmission: (
        request: Parameters<typeof root.client.verifyQualificationAdmission>[0],
      ) =>
        request.workflowRef === workflowRef
          ? verifyQualificationAdmission({
              ...request,
              runGh: current.runGh,
              downloadArchive: current.archive,
            })
          : root.client.verifyQualificationAdmission(request),
    };
    const result = validateReleaseRunEvidence(
      {
        ...verifier(root),
        verifierSourceSha: scenario === "changed P" ? "e".repeat(40) : root.p,
        ...(scenario.endsWith("execution-plan descendant")
          ? {
              expectedChangedPaths: changedPaths,
              expectedEvidencePolicy: promotion
                ? "stable-qualified-beta-final-v1"
                : "split-changelog-release-v1",
              expectedEvidenceSha: root.q,
              expectedRootRunId: root.runId,
              expectedSelectedRunId: root.runId,
              expectedTargetSha: targetSha,
            }
          : {
              reuseRequest: {
                targetSha,
                releaseProfile: root.manifest.releaseProfile,
                runReleaseSoak: root.manifest.runReleaseSoak,
                validationInputs: promotion
                  ? {
                      ...root.manifest.validationInputs,
                      targetVersion: "2099.1.1",
                      coveragePolicy: "npm-stable-v1",
                    }
                  : root.manifest.validationInputs,
              },
            }),
        qualificationReuse: {
          candidateSha,
          qualificationSha,
          workflowRef,
          descriptor: current.descriptor,
          inputs,
        },
      },
      client,
    );
    if (versionBound) {
      await expect(result).rejects.toThrow("version-bound release waiver");
    } else if (candidateBound && descendant) {
      await expect(result).rejects.toThrow("candidate-bound release waiver");
    } else if (
      scenario.endsWith("same qualification") ||
      (descendant && scenario !== "independent Q change on changelog descendant")
    ) {
      const evidence = await result;
      expect(evidence).toMatchObject({
        valid: true,
        directRoot: true,
        root: { runId: root.runId, workflowRefProof: "candidate-owned-admission-v1" },
        current: { conclusion: "success" },
      });
      if (promotion && !scenario.endsWith("execution-plan descendant")) {
        expect(evidence).toMatchObject({
          reuseSelection: {
            policy: "stable-qualified-beta-final-v1",
            changedPaths,
            targetSha,
          },
        });
      }
      if (candidateBound) {
        expect(evidence.waivers).toHaveLength(1);
        expect(evidence.children.find((child) => child.role === "normalCi")).toMatchObject({
          conclusion: "failure",
        });
      }
      expect(evidence.manifest.publicationArtifacts).toEqual(root.manifest.publicationArtifacts);
      expect(evidence.children.map((child) => child.runId)).toEqual(
        root.plan.children.map((child) => child.runId),
      );
    } else {
      await expect(result).rejects.toThrow(
        scenario === "revoked P" ? "qualification authority" : "exact admitted C/Q",
      );
    }
  });

  it.each(["newer main P", "diverged main P", "same candidate newer P"])(
    "reuses unchanged qualification with independently trusted %s",
    async (scenario) => {
      const root = candidatePublicationFixture({ protectedTag: false });
      const newerP = "c".repeat(40);
      const candidateSha = scenario === "same candidate newer P" ? root.q : "d".repeat(40);
      const workflowRef = "release-ci/" + candidateSha.slice(0, 12) + "-456";
      const inputs = structuredClone(root.plan.qualificationInputs);
      inputs.ref = candidateSha;
      inputs.expected_sha = candidateSha;
      assert(inputs.trusted_workflow_json);
      const envelope = JSON.parse(inputs.trusted_workflow_json);
      envelope.trustedWorkflow = {
        ref: workflowRef,
        fullRef: "refs/heads/" + workflowRef,
        sha: candidateSha,
      };
      inputs.trusted_workflow_json = JSON.stringify(envelope);
      const current = admissionFixture(false, {
        inputs,
        candidateSha,
        transportRef: workflowRef,
        candidateVersion: "2026.8.28-beta.1",
        policy: JSON.parse(readFileSync("scripts/lib/release-qualification-coverage.json", "utf8")),
        workflowSource: readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
        baselinePolicySource: readFileSync("scripts/lib/upgrade-survivor-scenarios.json", "utf8"),
        publisherSha: newerP,
      });
      envelope.qualificationAdmission = current.descriptor;
      inputs.trusted_workflow_json = JSON.stringify(envelope);
      const client = {
        ...root.client,
        compareCommits: () => ({
          status: "ahead",
          merge_base_commit: { sha: root.q },
          files: [
            { filename: "CHANGELOG/2026.8.28.md", status: "modified" },
            { filename: "CHANGELOG/records/2026.8.28.md", status: "modified" },
          ],
        }),
        compareCommitLineage: (base: string, head: string) => {
          if (base !== root.p || head !== newerP) {
            throw new Error("Unexpected lineage comparison");
          }
          return scenario === "newer main P"
            ? { status: "ahead", merge_base_commit: { sha: root.p } }
            : { status: "diverged", merge_base_commit: { sha: "a".repeat(40) } };
        },
        verifyQualificationAdmission: (
          request: Parameters<typeof root.client.verifyQualificationAdmission>[0],
        ) =>
          request.workflowRef === workflowRef
            ? verifyQualificationAdmission({
                ...request,
                runGh: current.runGh,
                downloadArchive: current.archive,
              })
            : root.client.verifyQualificationAdmission(request),
      };
      const result = validateReleaseRunEvidence(
        {
          repository: root.repository,
          runId: root.runId,
          trustedWorkflowRef: "main",
          trustedWorkflowFullRef: "refs/heads/main",
          trustedWorkflowSha: newerP,
          verifierSourceSha: newerP,
          verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
          reuseRequest: {
            targetSha: candidateSha,
            releaseProfile: root.manifest.releaseProfile,
            runReleaseSoak: root.manifest.runReleaseSoak,
            validationInputs: root.manifest.validationInputs,
          },
          qualificationReuse: {
            candidateSha,
            qualificationSha: candidateSha,
            workflowRef,
            descriptor: current.descriptor,
            inputs,
          },
        },
        client,
      );
      await expect(result).resolves.toMatchObject({
        valid: true,
        directRoot: true,
        root: { runId: root.runId, workflowRefProof: "candidate-owned-admission-v1" },
        current: { conclusion: "success" },
      });
    },
  );

  // Fast-tracked betas publish from build-only or failed FRV evidence. Stable promotion
  // must still find a passing stable-profile FRV for the beta it reuses.
  it.each(["build-only", "failed", "beta-profile"] as const)(
    "refuses beta-to-stable promotion from %s beta evidence",
    async (fault) => {
      const root = candidatePublicationFixture({
        candidateVersion: "2026.8.28-beta.1",
        releaseProfile: fault === "beta-profile" ? "beta" : "stable",
        reuseEvidence: false,
        ...(fault === "build-only" ? { rerunGroup: "build-only" as const } : {}),
      });
      const client =
        fault === "failed"
          ? {
              ...root.client,
              getRun: async (id: string) => ({
                ...(await root.client.getRun(id)),
                ...(id === root.runId ? { conclusion: "failure" } : {}),
              }),
              getRunView: async (id: string) => ({
                ...(await root.client.getRunView(id)),
                ...(id === root.runId ? { conclusion: "failure" } : {}),
              }),
            }
          : root.client;
      await expect(
        validateReleaseRunEvidence(
          {
            ...verifier(root),
            reuseRequest: {
              targetSha: "d".repeat(40),
              releaseProfile: "stable",
              runReleaseSoak: "true",
              validationInputs: {
                ...root.manifest.validationInputs,
                targetVersion: "2026.8.28",
                coveragePolicy: "npm-stable-v1",
              },
            },
          },
          client,
        ),
      ).rejects.toThrow(
        fault === "build-only"
          ? "Build-only artifacts require a fast-track request"
          : fault === "failed"
            ? "parent run is not completed/success"
            : "ineligible reuse candidate",
      );
    },
  );

  it.each(["main-qualification", "diagnostic"] as const)(
    "never promotes authenticated %s evidence to publication",
    async (purpose) => {
      const f = candidatePublicationFixture({ purpose });
      await expect(
        validateReleaseRunEvidence(
          {
            repository: f.repository,
            runId: f.runId,
            verifierSourceSha: f.p,
            verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
          },
          f.client,
        ),
      ).resolves.toMatchObject({ valid: true });
      await expect(consumers(f).npm()).rejects.toThrow("publish-purpose");
      await expect(consumers(f).docker()).rejects.toThrow("publish-purpose");
    },
  );
  it.each([
    "exact",
    "changelog",
    "retained artifacts",
    "changed retained IDs",
    "stable beta promotion",
  ])("retains the original admitted Q and child attempts through %s reuse", async (mode) => {
    const promotion = mode.endsWith("beta promotion");
    const releaseProfile = "stable";
    const root = candidatePublicationFixture(
      promotion
        ? {
            candidateVersion: "2026.8.28-beta.1",
            releaseProfile,
            reuseEvidence: false,
          }
        : {},
    );
    const retainArtifacts = mode === "retained artifacts" || mode === "changed retained IDs";
    const current = candidatePublicationFixture({
      candidateSha: mode === "changelog" || promotion ? "d".repeat(40) : root.q,
      ...(promotion ? { candidateVersion: "2026.8.28", releaseProfile } : {}),
      ...(retainArtifacts ? { transportRef: `release-ci/${root.q.slice(0, 12)}-456` } : {}),
      runId: "29071366026",
    });
    const policy = promotion
      ? "stable-qualified-beta-final-v1"
      : mode === "changelog"
        ? "changelog-only-release-v1"
        : "exact-target-full-validation-v1";
    const changedPaths = promotion
      ? [
          "package.json",
          "extensions/discord/package.json",
          "docs/plugins/plugin-inventory.md",
          "scripts/lib/official-external-channel-catalog.json",
        ]
      : mode === "changelog"
        ? ["CHANGELOG.md"]
        : [];
    Object.assign(current.manifest, {
      childRuns: structuredClone(root.manifest.childRuns),
      childEvidence: structuredClone(root.manifest.childEvidence),
      evidenceReuse: {
        policy,
        runId: root.runId,
        selectedRunId: root.runId,
        evidenceSha: root.q,
        changedPaths,
        publication: {
          sourceAdmissionContract: "1",
          sourceAdmission: root.source,
          publicationAdmissionContract: "1",
          publicationAdmission: root.manifest.publicationAdmission,
        },
      },
    });
    if (retainArtifacts) {
      current.manifest.publicationArtifacts = structuredClone(root.manifest.publicationArtifacts);
      if (mode === "changed retained IDs") {
        current.manifest.publicationArtifacts.npmPreflight.producer.runId = "99991";
        current.manifest.publicationArtifacts.npmPreflight.artifact.runId = "99991";
        current.manifest.publicationArtifacts.docker.preparedRunId = "99992";
      }
    }
    current.plan.children = root.plan.children.map((child) =>
      Object.assign({}, child, { source: "reused" }),
    );
    current.plan.evidenceReuse = {
      requested: true,
      policy,
      rootRunId: root.runId,
      selectedRunId: root.runId,
      evidenceSha: root.q,
      changedPaths,
      runUrl: root.parent.html_url,
      sourceManifest: root.manifest,
    };
    // Use the producer boundary: its normalized reuse payload owns digest order.
    Object.assign(
      current.plan,
      buildReleaseExecutionPlanArtifact({ ...current.plan, expected: current.plan }),
    );
    const restored = validateReleaseExecutionPlanArtifact(current.plan);
    expect(validateReleaseExecutionPlanArtifact(restored).sha256).toBe(current.plan.sha256);
    current.manifest.executionPlanSha256 = current.plan.sha256;
    if (promotion) {
      // Exercise the real manifest producer before authenticating its output.
      Object.assign(
        current.manifest,
        buildReleaseValidationManifest({
          plan: current.plan,
          drain: undefined,
          context: current.manifest,
          reusedManifest: root.manifest,
        }),
        { childEvidence: root.manifest.childEvidence },
      );
    }
    const selected = (id: string) => (id === current.runId ? current.client : root.client);
    const client = {
      ...current.client,
      getRun: (id: string) => selected(id).getRun(id),
      getRunView: (id: string) => selected(id).getRunView(id),
      getRunAttempt: (id: string, attempt: number) => selected(id).getRunAttempt(id, attempt),
      getParentJobs: (id: string) => selected(id).getParentJobs(id),
      getRunAttemptJobs: (id: string) => selected(id).getRunAttemptJobs(id),
      getJobLog: (id: number) => (id === 10902 ? current.client : root.client).getJobLog(id),
      loadManifest: (id: string) => selected(id).loadManifest(),
      loadExecutionPlan: (id: string) => selected(id).loadExecutionPlan(),
      loadExecutionPlanEvidence: (id: string) => selected(id).loadExecutionPlanEvidence(),
      verifyQualificationAdmission: (
        request: Parameters<typeof current.client.verifyQualificationAdmission>[0],
      ) =>
        (request.workflowRef === root.manifest.workflowRef
          ? root.client
          : current.client
        ).verifyQualificationAdmission(request),
      compareCommits: (base: string, head: string) => {
        expect([base, head]).toEqual([root.q, current.q]);
        return {
          status: "ahead",
          merge_base_commit: { sha: root.q },
          files: (promotion ? changedPaths : ["CHANGELOG.md"]).map((filename) => ({
            filename,
            status: "modified",
          })),
        };
      },
      getSourceFile: (sha: string, path: string) => {
        const version = sha === root.c ? "2026.8.28-beta.1" : "2026.8.28";
        if (path.endsWith("official-external-channel-catalog.json")) {
          return JSON.stringify({
            entries: [
              {
                name: "@openclaw/discord",
                source: "official",
                version,
                openclaw: {
                  install: {
                    minHostVersion: ">=2026.8.28-beta.1",
                    npmSpec: "external@2026.8.28-beta.1",
                  },
                },
              },
            ],
          });
        }
        return path.endsWith(".md")
          ? `Plugin inventory: ${version}`
          : JSON.stringify({
              name: path === "package.json" ? "openclaw" : "@openclaw/discord",
              version,
              ...(path.startsWith("extensions/")
                ? {
                    peerDependencies: { openclaw: ">=" + version },
                    openclaw: {
                      build: { openclawVersion: version },
                      compat: { pluginApi: ">=" + version },
                    },
                  }
                : {}),
            });
      },
    };
    const validation = validateReleaseRunEvidence(verifier(current), client);
    if (mode === "changed retained IDs") {
      await expect(validation).rejects.toThrow("Reused publication artifacts differ");
      return;
    }
    const result = await validation;
    expect(result.current.targetSha).toBe(current.q);
    expect(result.root.targetSha).toBe(root.q);
    expect(
      result.children.every((child) => child.workflowSha === root.q && child.runAttempt === 1),
    ).toBe(true);
    expect(result.current.conclusion).toBe("success");
    const publication = consumers(
      retainArtifacts ? { ...root, manifest: current.manifest } : current,
      client,
    );
    await expect(publication.npm()).resolves.toEqual(
      retainArtifacts ? root.npmQualified : current.npmQualified,
    );
    await expect(publication.docker()).resolves.toBeDefined();
    if (mode === "changelog" || promotion) {
      const staleArtifacts = consumers({ ...root, manifest: current.manifest }, client);
      await expect(staleArtifacts.npm()).rejects.toThrow(
        "Publication artifact is not bound to authenticated candidate qualification",
      );
      await expect(staleArtifacts.docker()).rejects.toThrow(
        "Publication artifact is not bound to authenticated candidate qualification",
      );
    }
  });

  it("authenticates P admission, strict FRV, and both original artifact producers without Q ancestry", async () => {
    const f = candidatePublicationFixture();
    const before = JSON.stringify(f.manifest);
    let manifestReads = 0;
    let authorityRefreshes = 0;
    const qualified = await authenticateFullReleaseValidationEvidence(
      {
        ...publicationEvidenceOptions(f),
        npmPreflightLineage: {
          qualificationSha: f.q,
          producerRunId: f.runId,
          producerRunAttempt: "1",
        },
      },
      {
        ...f.client,
        verifyRetainedPublicationArtifacts() {
          throw new Error("Qualification fixture does not recover publication artifacts");
        },
        downloadArtifactArchive() {
          throw new Error("Qualification fixture does not download artifact archives");
        },
        getRunArtifacts() {
          throw new Error("Qualification fixture does not list run artifacts");
        },
        loadManifest: () => {
          manifestReads += 1;
          return f.client.loadManifest();
        },
        revalidateQualificationAdmissionAuthority: (authority) => {
          authorityRefreshes += 1;
          return f.client.revalidateQualificationAdmissionAuthority(authority);
        },
      },
    );
    expect(qualified.source).toBe("candidate-owned-admission-v1");
    expect(manifestReads).toBe(1);
    expect(authorityRefreshes).toBe(2);
    expect(npmProducer(f).provenance).toBe("immutable-manifest");
    const outputDir = join(tempDirs.make("candidate-npm-consumption-"), "qualified");
    await downloadFullReleaseNpmPreflight({
      manifest: f.manifest,
      repository: f.repository,
      runId: f.runId,
      runAttempt: "1",
      sourceSha: f.q,
      toolingSha: f.q,
      outputDir,
      token: "test-artifact-token",
      runGh: f.runGh,
      fetchImpl: async (url) =>
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith("/zip")
          ? new Response(new Uint8Array(f.npmArchive))
          : Response.json(f.npmArtifact),
    });
    expect(readFileSync(join(outputDir, "preflight-manifest.json"), "utf8")).toBe(
      f.npmManifestBytes,
    );
    expect(readFileSync(join(outputDir, "openclaw.tgz"), "utf8")).toBe(f.npmBytes);
    validateDockerReleaseManifest(f.docker, {
      repository: f.repository,
      sourceSha: f.q,
      tag: f.docker.tag,
      artifactName: f.docker.artifactName,
      runId: f.runId,
      runAttempt: "1",
    });
    expect((await consumers(f).docker()).manifest).toBe(f.docker);
    expect(JSON.stringify(f.docker, null, 2) + "\n").toBe(f.dockerBytes);
    expect(f.docker.architectures.map((entry) => entry.artifact.digest)).toEqual(
      f.payloadBytes.map((bytes) => "sha256:" + sha256(bytes)),
    );
    expect(JSON.stringify(f.manifest)).toBe(before);
    expect(f.admission.calls.some((call) => call.includes("compare/" + f.q))).toBe(false);
  });

  it.each(["producer run", "producer attempt", "qualification", "revoked after wait"])(
    "rejects %s in the single-authentication npm handoff",
    async (failure) => {
      const f = candidatePublicationFixture();
      let manifestReads = 0;
      let authorityRefreshes = 0;
      const operation = authenticateFullReleaseValidationEvidence(
        {
          ...publicationEvidenceOptions(f),
          npmPreflightLineage: {
            qualificationSha: failure === "qualification" ? f.p : f.q,
            producerRunId: failure === "producer run" ? "99999" : f.runId,
            producerRunAttempt: failure === "producer attempt" ? "2" : "1",
          },
        },
        {
          ...f.client,
          verifyRetainedPublicationArtifacts() {
            throw new Error("Qualification fixture does not recover publication artifacts");
          },
          downloadArtifactArchive() {
            throw new Error("Qualification fixture does not download artifact archives");
          },
          getRunArtifacts() {
            throw new Error("Qualification fixture does not list run artifacts");
          },
          loadManifest: () => {
            manifestReads += 1;
            return f.client.loadManifest();
          },
          revalidateQualificationAdmissionAuthority: (authority) => {
            authorityRefreshes += 1;
            const result = f.client.revalidateQualificationAdmissionAuthority(authority);
            if (failure === "revoked after wait" && authorityRefreshes === 1) {
              // The import/consumer handoff yields after the initial refresh.
              queueMicrotask(() => {
                f.admission.authority.permission = "read";
              });
            }
            return result;
          },
        },
      );
      await expect(operation).rejects.toThrow(
        failure === "revoked after wait"
          ? /qualification authority/
          : failure === "qualification"
            ? /not bound to authenticated candidate qualification/
            : /Npm producer differs/,
      );
      expect(manifestReads).toBe(1);
      if (failure === "revoked after wait") {
        expect(authorityRefreshes).toBe(2);
      }
    },
  );

  it.each([
    "P attempt",
    "P archive digest",
    "P archive bytes",
    "P revoked",
    "missing required gate",
  ])("rejects %s in both consumers before consuming publication artifacts", async (failure) => {
    const f = candidatePublicationFixture();
    if (failure === "P attempt") {
      f.admission.run.run_attempt = 2;
    }
    if (failure === "P archive digest") {
      f.admission.metadata.digest = "sha256:" + "f".repeat(64);
    }
    if (failure === "P archive bytes") {
      f.admission.archive().writeUInt8(f.admission.archive().readUInt8(0) ^ 1, 0);
    }
    if (failure === "P revoked") {
      f.admission.authority.permission = "read";
    }
    if (failure === "missing required gate") {
      const original = f.client.getRunAttemptJobs;
      f.client.getRunAttemptJobs = async (id: string) => (id === f.runId ? original(id) : []);
    }
    await expect(consumers(f).npm()).rejects.toThrow();
    await expect(consumers(f).docker()).rejects.toThrow();
  });

  it("rejects changed npm artifact digest and Docker payload or manifest bytes after real admission", async () => {
    const f = candidatePublicationFixture();
    await consumers(f).npm();
    f.npmArtifact.digest = "sha256:" + "f".repeat(64);
    expect(() => npmProducer(f)).toThrow("artifact identity changed");
    f.dockerArtifacts[0]!.digest = "sha256:" + "f".repeat(64);
    await expect(consumers(f).docker()).rejects.toThrow("payload artifact changed");
    f.dockerArtifacts[0]!.digest = f.docker.architectures[0]!.artifact.digest;
    f.docker.architectures[0]!.images[0]!.imageDigest = "sha256:" + "e".repeat(64);
    await expect(consumers(f).docker()).rejects.toThrow("bytes differ");
  });
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicationSourceFact } from "../../scripts/full-release-publication-contract.mjs";
import { receiptRecoverySourceRequest } from "../../scripts/full-release-receipt-recovery.mjs";
import { retainedPublicationArtifactSource } from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

describe("receipt recovery production boundaries", () => {
  it("seals and publishes original artifacts when normal CI came from another transport", () => {
    const old = candidatePublicationFixture({ runId: "10" });
    const p = "c".repeat(40);
    const producer = { runId: "900", runAttempt: 1, fullRef: "refs/heads/main", sha: p };
    const source = createPublicationSourceFact(
      receiptRecoverySourceRequest(old.admission.receipt, producer),
      { packages: [], platforms: [] },
      old.source.projection,
    );
    const observations = {
      ...old.manifest.publicationAdmission!.observations,
      sourceDigest: source.digest,
    };
    const request = {
      schema: "openclaw.full-release-receipt-recovery/v1",
      requestId: "12345678-1234-4123-8123-123456789abc",
      repository: old.repository,
      workflowSha: p,
      originalParent: { runId: old.runId, runAttempt: 1 },
      qualificationAdmission: old.admission.descriptor,
      candidateBinding: {
        request: { targetSha: old.q, toolingSha: old.q },
        producer: { runId: "51", runAttempt: 1 },
      },
      children: {
        normalCi: {
          runId: "50",
          runAttempt: 1,
          sourceParentRunId: "5",
          workflowRef: "release-ci/" + old.q.slice(0, 12) + "-5",
        },
      },
      publicationArtifacts: old.manifest.publicationArtifacts,
    };
    // The admit phase owns receipt/payload validation. Start at its persisted
    // output to exercise the real seal command and downstream npm binding.
    old.admission.verify();
    const responses: Record<string, string> = Object.fromEntries(
      [...new Set(old.admission.calls)].map((route) => [
        route,
        old.admission.runGh(["api", route]),
      ]),
    );
    const prefix = "repos/" + old.repository + "/";
    const observationArtifact = {
      id: 444,
      name: "full-release-publication-observations-900-1",
      digest: "sha256:" + "d".repeat(64),
      size_in_bytes: 100,
      workflow_run: { id: 900, head_sha: p },
    };
    responses[prefix + "actions/artifacts/444"] = JSON.stringify(observationArtifact);
    const tuples = [
      request.originalParent,
      ...Object.values(request.children),
      request.candidateBinding.producer,
      request.publicationArtifacts!.npmPreflight.producer,
      {
        runId: request.publicationArtifacts!.docker.preparedRunId,
        runAttempt: request.publicationArtifacts!.docker.preparedRunAttempt,
      },
    ];
    for (const tuple of tuples) {
      responses[prefix + "actions/runs/" + tuple.runId] = JSON.stringify({
        id: Number(tuple.runId),
        run_attempt: Number(tuple.runAttempt),
        head_sha: old.q,
        status: "completed",
        conclusion: "success",
      });
    }
    const directory = mkdtempSync(join(tmpdir(), "recovery-boundary-"));
    try {
      const recoveryDirectory = join(directory, "receipt-recovery");
      mkdirSync(recoveryDirectory);
      writeFileSync(join(recoveryDirectory, "source.json"), JSON.stringify(source));
      writeFileSync(
        join(recoveryDirectory, "publication-observations.json"),
        JSON.stringify(observations),
      );
      writeFileSync(
        join(recoveryDirectory, "verified-qualification.json"),
        JSON.stringify({
          payloads: [],
          children: [],
          originalParent: { head_branch: old.branch, conclusion: "success" },
        }),
      );
      writeFileSync(join(directory, "responses.json"), JSON.stringify(responses));
      writeFileSync(join(directory, "admission.zip"), old.admission.archive());
      const preload = join(directory, "transport.mjs");
      writeFileSync(
        preload,
        `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super("2026-08-28T12:00:00.000Z");
  }
  static now() { return NativeDate.parse("2026-08-28T12:00:00.000Z"); }
};
const directory = process.env.RECOVERY_TEST_DIRECTORY;
const responses = JSON.parse(readFileSync(join(directory, "responses.json"), "utf8"));
childProcess.execFileSync = (command, args) => {
  if (basename(command) !== "gh") throw new Error("Unexpected subprocess: " + command);
  const endpoint = args.find((entry) => entry.startsWith("repos/"));
  if (endpoint?.endsWith("/actions/artifacts/70/zip")) return readFileSync(join(directory, "admission.zip"));
  if (Object.hasOwn(responses, endpoint)) return responses[endpoint];
  if (endpoint?.includes("/compare/")) return JSON.stringify({status: "ahead"});
  if (endpoint?.endsWith("/actions/runs/900")) return JSON.stringify({
    id: 900, run_attempt: 1, repository: { full_name: "openclaw/openclaw" },
    head_sha: "c".repeat(40), head_branch: "main",
    path: ".github/workflows/full-release-receipt-recovery.yml",
    event: "workflow_dispatch", status: "in_progress", conclusion: null,
    actor: {id: 1, login: "operator", type: "User"},
    triggering_actor: {id: 1, login: "operator", type: "User"}
  });
  if (endpoint?.endsWith("/collaborators/operator/permission")) return JSON.stringify({
    permission: "write", user: {id: 1, login: "operator"}
  });
  throw new Error("Unexpected GitHub request: " + endpoint);
};
childProcess.spawn = (command, args) => {
  const output = childProcess.execFileSync(command, args);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.emit("close", 0, null);
  });
  return child;
};
syncBuiltinESMExports();
`,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", preload, "scripts/full-release-receipt-recovery.mjs", "seal"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
            GH_BIN: "gh",
            RUNNER_TEMP: directory,
            RECOVERY_TEST_DIRECTORY: directory,
            GITHUB_RUN_ID: "900",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_REF: "refs/heads/main",
            GITHUB_SHA: p,
            GITHUB_WORKFLOW_SHA: p,
            GITHUB_OUTPUT: join(directory, "output"),
            OBSERVATIONS_ARTIFACT_ID: "444",
            OBSERVATIONS_ARTIFACT_DIGEST: "d".repeat(64),
            RECEIPT_RECOVERY_REQUEST: JSON.stringify(request),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(recoveryDirectory, "full-release-validation-manifest.json"), "utf8"),
      );
      expect(manifest.receiptRecovery.children.normalCi.workflowRef).not.toBe(old.branch);
      expect(retainedPublicationArtifactSource(manifest)?.workflow.ref).toBe(
        "refs/heads/" + old.branch,
      );
      expect(() =>
        validateFullReleaseNpmPreflight({
          manifest,
          repository: old.repository,
          runId: "900",
          runAttempt: "1",
          sourceSha: old.q,
          toolingSha: old.q,
        }),
      ).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

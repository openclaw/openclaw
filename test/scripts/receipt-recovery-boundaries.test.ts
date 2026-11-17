import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicationSourceFact } from "../../scripts/full-release-publication-contract.mjs";
import { receiptRecoverySourceRequest } from "../../scripts/full-release-receipt-recovery.mjs";
import { retainedPublicationArtifactSource } from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import { createReleaseEvidenceClient } from "../../scripts/release-ci-summary.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

describe("receipt recovery production boundaries", () => {
  it("reads frozen sources required by complete qualification through the real client", () => {
    const q = "a".repeat(40);
    const paths = [
      ".github/workflows/openclaw-performance.yml",
      ".github/workflows/package-acceptance.yml",
      ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      ".github/workflows/npm-telegram-beta-e2e.yml",
      "scripts/lib/cross-os-release-checks/config.ts",
      "scripts/plan-release-workflow-matrix.mjs",
      "scripts/lib/update-compat-inventory.json",
      ".github/workflows/install-smoke-reusable.yml",
      ".github/workflows/qa-live-transports-convex.yml",
      "scripts/plan-targeted-docker-lane-groups.mjs",
      "scripts/lib/update-first-hop-lanes.mjs",
      "scripts/e2e/lib/upgrade-survivor/installed-recovery-cases.mjs",
      "scripts/lib/release-version.mjs",
      "scripts/lib/numeric-options.mjs",
      "scripts/lib/upgrade-survivor-policy.mjs",
      "scripts/lib/upgrade-survivor-scenarios.json",
      "package.json",
    ];
    const blobs = new Map<string, string>();
    const client = createReleaseEvidenceClient("openclaw/openclaw", {
      immutableReads: {
        text(route: string) {
          if (route === "contents/scripts/e2e/lib/upgrade-survivor?ref=" + "b".repeat(40)) {
            return JSON.stringify([
              {
                name: "custom-plugin-siblings.mjs",
                path: "scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs",
              },
            ]);
          }
          if (blobs.has(route)) {
            return blobs.get(route)!;
          }
          const path = paths.find((entry) => route === "contents/" + entry + "?ref=" + q);
          if (!path) {
            throw new Error("Unexpected immutable source request: " + route);
          }
          const bytes = readFileSync(path);
          const blob = {
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
            sha: createHash("sha1")
              .update("blob " + bytes.length + "\0")
              .update(bytes)
              .digest("hex"),
          };
          blobs.set("git/blobs/" + blob.sha, JSON.stringify(blob));
          return JSON.stringify({
            ...blob,
            type: "file",
            path,
            ...(bytes.length > 1024 * 1024 ? { encoding: "none", content: "" } : {}),
          });
        },
      },
    });
    expect(client.getCandidateFileNames("b".repeat(40))).toEqual(["custom-plugin-siblings.mjs"]);
    for (const path of paths) {
      expect(client.getWorkflowSource(q, path)).toBe(readFileSync(path, "utf8"));
    }
  });

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
      request.publicationArtifacts!.pluginNpm,
    ];
    for (const tuple of tuples) {
      if (tuple) {
        responses[prefix + "actions/runs/" + tuple.runId] = JSON.stringify({
          id: Number(tuple.runId),
          run_attempt: Number(tuple.runAttempt),
          head_sha: old.q,
          status: "completed",
          conclusion: "success",
        });
      }
    }
    const directory = mkdtempSync(join(process.cwd(), ".openclaw/tmp/recovery-boundary-"));
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

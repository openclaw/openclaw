import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { verifyOriginalReceiptQualification } from "../../scripts/full-release-receipt-recovery.mjs";
import { evaluateReleasePublishGates } from "../../scripts/lib/release-publish-gates.mts";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { recoveryConsumptionFixture } from "./release-evidence-consumption.test-support.js";

const workflow = parse(readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8"));
const step = workflow.jobs.verify.steps.find(
  (entry: { name: string }) => entry.name === "Verify release workflow evidence",
);
// Execute the shipped caller, replacing only file/API transport. The recovery
// verifier, original admission, child receipts and release controls remain real.
const script = step.run.match(
  /node --input-type=module - "\$RUNNER_TEMP\/full-release-validation-run.json"[^\n]* <<'NODE'\n([\s\S]*?)\nNODE/u,
)?.[1];
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const verify = new AsyncFunction(
  "readFileSync",
  "validateReleaseRunEvidence",
  "createReleaseEvidenceClient",
  "process",
  script?.replace(/^import .*?;$/gmu, "") ?? 'throw new Error("missing workflow caller")',
);
const verifierSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("accepts authenticated stable recovery at the workflow evidence gate without changing receipts", async () => {
  const f = recoveryConsumptionFixture(
    candidatePublicationFixture({ releaseProfile: "stable", qualificationSha: "d".repeat(40) }),
  );
  f.runs.get(f.direct.runId)!.conclusion = "failure";
  const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
  f.manifest.retainedPublicationPayloads = original.publication.payloads;
  const before = JSON.stringify(f.manifest);
  const run = () =>
    verify(
      (path: string) => JSON.stringify(path === "run" ? f.run : f.manifest),
      validateReleaseRunEvidence,
      () => f.client,
      {
        argv: ["node", "-", "run", "manifest"],
        env: {
          GITHUB_REPOSITORY: f.direct.repository,
          FULL_RELEASE_VALIDATION_RUN_ID: "900",
          FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1",
          SOURCE_SHA: f.direct.c,
          CLOSEOUT_TOOLING_SHA: verifierSha,
        },
      },
    );
  await expect(run()).resolves.toBeUndefined();
  expect(
    evaluateReleasePublishGates({
      manifest: f.manifest,
      releaseTag: "v2026.8.28",
      npmDistTag: "latest",
      consumer: "stable-closeout",
    }).filter((gate) => gate.status === "FAIL"),
  ).toEqual([]);
  expect(JSON.stringify(f.manifest)).toBe(before);

  f.recoveryAuthority.permission = "read";
  await expect(run()).rejects.toThrow(
    "Qualification operator no longer has repository qualification authority",
  );
});

it("preserves strict legacy run identity and immutable attempt checks", async () => {
  const run = {
    name: "Full Release Validation",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  const verifyRun = () =>
    verify(
      (path: string) => JSON.stringify(path === "run" ? run : {}),
      validateReleaseRunEvidence,
      () => {
        throw new Error("legacy closeout must not require retained Actions artifacts");
      },
      { argv: ["node", "-", "run", "manifest"], env: { FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1" } },
    );
  await expect(verifyRun()).resolves.toBeUndefined();
  run.name = "Receipt Recovery unbound";
  await expect(verifyRun()).rejects.toThrow("name=Full Release Validation");
  run.name = "Full Release Validation";
  run.run_attempt = 2;
  await expect(verifyRun()).rejects.toThrow("run attempt mismatch");
});

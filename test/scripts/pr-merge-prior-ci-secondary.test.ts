import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import {
  expectExit,
  expectPriorCiRefusal,
  applyFault,
  completedStep,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const producerName = "Run built artifact checks";
const uploadName = "Upload Discord component attachment proof";
const action = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const output = "discord-component-attachments";
const outputPath = `/home/runner/_work/_temp/${output}`;
const monitorName = "Classify PR failures and cancel eligible same-repository work";
const historicalProducer = readFileSync(
  new URL("../fixtures/pr-prior-ci-discord-producer.txt", import.meta.url),
  "utf8",
);

function secondaryCandidate(fault = "") {
  const producer = {
    name: producerName,
    shell: "bash",
    env: {
      RUN_DISCORD_COMPONENT_PROOF: "${{ needs.preflight.outputs.run_discord_component_proof }}",
    },
    run: historicalProducer + (fault === "changed producer" ? "echo changed\n" : ""),
  };
  const upload = {
    name: uploadName,
    if: "always() && needs.preflight.outputs.run_discord_component_proof == 'true'",
    uses: fault === "changed action" ? "actions/upload-artifact@main" : action,
    with: {
      name: output,
      path: `\${{ runner.temp }}/${output}.json\n\${{ runner.temp }}/${output}.log\n`,
      "if-no-files-found": "error",
      "retention-days": 7,
    },
  };
  if (fault === "changed outputs") {
    upload.with.path = "${{ runner.temp }}/other-proof.json";
  }
  const f = preExistingCandidate(
    stringify({ jobs: { "build-artifacts": { steps: [producer, upload] } } }),
  );
  const state = f.state();
  const time = (value: string) => `2026-09-28T07:${value}Z`;
  const step = (n: number, name: string, result: string, start: string, end = start) =>
    completedStep(n, name, result, time(start), time(end));
  const monitor = step(4, monitorName, "success", "18:46", "20:36");
  state.priorCi.jobs![2]!.steps = [monitor];
  const job = state.priorCi.jobs![3]!;
  job.name = "build-artifacts";
  const steps = (job.steps = [
    step(3, "Checkout", "success", "18:36", "18:45"),
    step(6, "Build dist", "cancelled", "19:01", "20:48"),
    step(12, producerName, "skipped", "20:48"),
    step(13, uploadName, "failure", "20:48", "20:49"),
    step(31, "Complete job", "success", "20:49"),
  ]);
  const log = join(f.root, "build-job.log");
  const line = (at: string, text: string, name = uploadName) =>
    `build-artifacts\t${name}\t${time(at)} ${text}`;
  const continuation = (text: string) => `build-artifacts\t${uploadName}\t${text}`;
  const lines = [
    line("18:36.158", `  CHECKOUT_SHA: ${f.evidence.testedMerge}`, "Checkout"),
    line("18:36.159", `  WORKFLOW_SHA: ${f.evidence.testedMerge}`, "Checkout"),
    line("20:48.833", "##[error]The operation was canceled.", "Build dist"),
    line("20:48.846", `##[group]Run ${action}`),
    line("20:49.092", `##[error]No files were found with the provided path: ${outputPath}.json`),
    continuation(`${outputPath}.log. No artifacts will be uploaded.`),
    line("20:49.420", "Cleaning up orphan processes", "Complete job"),
  ];
  applyFault(fault, {
    "transport failure": () =>
      (lines[4] = line("20:49.092", "##[error]Artifact transport failed: ECONNRESET")),
    "extra error": () => lines.splice(-1, 0, line("20:49.200", "##[error]Another failure")),
    "foreign continuation": () => (lines[5] = lines[5]!.replace(uploadName, "Unrelated cleanup")),
    "truncated log": () => lines.pop(),
  });
  writeFileSync(log, lines.join("\n") + "\n");
  const evidence = {
    ...f.evidence,
    artifacts: [
      ...f.evidence.artifacts,
      {
        name: "build-log",
        path: log,
        sha256: createHash("sha256").update(readFileSync(log)).digest("hex"),
      },
    ],
    cancellation: {
      ...f.evidence.cancellation,
      step: 4,
      secondaryFailures: [
        {
          kind: "missing-artifact-after-skipped-producer",
          jobId: job.id,
          step: 13,
          producerStep: 12,
          log: "build-log",
          reason: "Inspected full log: skipped producer, both outputs missing after cancellation.",
          evidence: ["qualification", "build-log"],
        },
      ],
    },
  };
  const secondary = evidence.cancellation.secondaryFailures[0]!;
  applyFault(fault, {
    "cleanup failure": () => (steps[4]!.conclusion = "failure"),
    "test failure": () => {
      state.priorCi.jobs!.push({
        ...job,
        id: 606,
        name: "other-tests",
        steps: [step(1, "Product assertion", "failure", "20:40")],
      });
      evidence.cancellation.jobIds.push(606);
    },
    success: () => (steps[2]!.conclusion = "success"),
    failure: () => (steps[2]!.conclusion = "failure"),
    cancelled: () => (steps[2]!.conclusion = "cancelled"),
    "missing producer": () => steps.splice(2, 1),
    "earlier upload": () => (steps[3]!.started_at = "2026-09-28T07:20:35Z"),
    "missing time": () => delete monitor.completed_at,
    "failed monitor": () => (monitor.conclusion = "failure"),
    "wrong step": () => (secondary.step = 12),
    "duplicate secondary": () => evidence.cancellation.secondaryFailures.push({ ...secondary }),
    "relabel root": () => evidence.cancellation.causedBy.push(job.id),
    "unbound log": () => (secondary.evidence = ["qualification"]),
    "changed log": () => writeFileSync(log, "changed\n"),
  });
  f.save(state);
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}

describePosix("prior-CI skipped-producer secondary failure", () => {
  it("lands only the qualified secondary upload while preserving roots and cancelled coverage", () => {
    const f = secondaryCandidate();
    expectExit(f.adminPriorCi(f.path), 0);
    expect(f.state().mutations).toBe(1);
    const proof = f.record().priorCiAdmin;
    expect(proof.failures.map((failure: { jobId: number }) => failure.jobId)).toEqual([601]);
    expect(proof).toMatchObject({
      cancelledJobIds: [604],
      aggregate: { causedBy: [601] },
      cancellation: {
        causedBy: [601],
        secondaryFailures: [
          {
            jobId: 604,
            step: 13,
            producerStep: 12,
            workflowBlob: f.git(["rev-parse", `${f.base}:.github/workflows/ci.yml`]),
            logSha256: f.evidence.artifacts[1]!.sha256,
          },
        ],
      },
    });
    expect(f.state().comments[0]?.body).toContain("Cancelled jobs remain unrun coverage");
  });

  it.each([
    ["changed producer", "historical producer/action/output"],
    ["changed action", "historical producer/action/output"],
    ["changed outputs", "historical producer/action/output"],
    ["cleanup failure", "cancelled jobs must not hide failed steps"],
    ["test failure", "cancelled jobs must not hide failed steps"],
    ["success", "uniquely skipped producer"],
    ["failure", "uniquely skipped producer"],
    ["cancelled", "uniquely skipped producer"],
    ["missing producer", "needs one Run built artifact checks"],
    ["transport failure", "both missing outputs"],
    ["extra error", "both missing outputs"],
    ["foreign continuation", "continuation belongs to another"],
    ["truncated log", "complete job log"],
    ["earlier upload", "contradictory cancellation timestamps"],
    ["missing time", "contradictory cancellation timestamps"],
    ["failed monitor", "explicit inspected fail-fast provenance"],
    ["wrong step", "uniquely skipped producer"],
    ["duplicate secondary", "only supports one"],
    ["relabel root", "explicit inspected fail-fast provenance"],
    ["unbound log", "unique cancelled build-artifacts"],
    ["changed log", "retained failure evidence changed"],
  ])("refuses %s without dispatch", (fault, message) => {
    const f = secondaryCandidate(fault);
    expectPriorCiRefusal(f, message);
    expect(() => f.record()).toThrow();
  });
});

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const producerName = "Run built artifact checks";
const uploadName = "Upload Discord component attachment proof";
const action = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
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
      name: "discord-component-attachments",
      path: "${{ runner.temp }}/discord-component-attachments.json\n${{ runner.temp }}/discord-component-attachments.log\n",
      "if-no-files-found": "error",
      "retention-days": 7,
    },
  };
  if (fault === "changed outputs") {
    upload.with.path = "${{ runner.temp }}/other-proof.json";
  }
  const f = preExistingCandidate(
    stringify({
      jobs: {
        "build-artifacts": {
          steps: [{ name: "Build dist", run: "pnpm build" }, producer, upload],
        },
      },
    }),
  );
  const state = f.state();
  const step = (number: number, name: string, conclusion: string, start: string, end = start) => ({
    number,
    name,
    status: "completed",
    conclusion,
    started_at: `2026-09-28T07:${start}Z`,
    completed_at: `2026-09-28T07:${end}Z`,
  });
  state.priorCi.jobs![2]!.steps = [
    step(
      4,
      "Classify PR failures and cancel eligible same-repository work",
      "success",
      "18:46",
      "20:36",
    ),
  ];
  const job = state.priorCi.jobs![3]!;
  job.name = "build-artifacts";
  job.steps = [
    step(3, "Checkout", "success", "18:36", "18:45"),
    step(6, "Build dist", "cancelled", "19:01", "20:48"),
    step(12, producerName, "skipped", "20:48"),
    step(13, uploadName, "failure", "20:48", "20:49"),
    step(31, "Complete job", "success", "20:49"),
  ];
  const log = join(f.root, "build-job.log");
  const line = (name: string, time: string, text: string) =>
    `build-artifacts\t${name}\t2026-09-28T07:${time}Z ${text}`;
  const lines = [
    line("Checkout", "18:36.158", `  CHECKOUT_SHA: ${f.evidence.testedMerge}`),
    line("Checkout", "18:36.159", `  WORKFLOW_SHA: ${f.evidence.testedMerge}`),
    line("Build dist", "20:48.833", "##[error]The operation was canceled."),
    line(uploadName, "20:48.846", `##[group]Run ${action}`),
    line(uploadName, "20:48.847", "with:"),
    line(
      uploadName,
      "20:48.848",
      "  path: /home/runner/_work/_temp/discord-component-attachments.json",
    ),
    `build-artifacts\t${uploadName}\t/home/runner/_work/_temp/discord-component-attachments.log`,
    line(
      uploadName,
      "20:49.092",
      "##[error]No files were found with the provided path: /home/runner/_work/_temp/discord-component-attachments.json",
    ),
    `build-artifacts\t${uploadName}\t/home/runner/_work/_temp/discord-component-attachments.log. No artifacts will be uploaded.`,
    line("Complete job", "20:49.420", "Cleaning up orphan processes"),
  ];
  if (fault === "transport failure") {
    lines[7] = line(uploadName, "20:49.092", "##[error]Artifact transport failed: ECONNRESET");
  }
  if (fault === "extra error") {
    lines.splice(-1, 0, line(uploadName, "20:49.200", "##[error]Another failure"));
  }
  if (fault === "foreign continuation") {
    lines[8] = lines[8]!.replace(uploadName, "Unrelated cleanup");
  }
  if (fault === "truncated log") {
    lines.pop();
  }
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
          reason:
            "Inspected the full log and skipped producer; only both missing outputs failed after cancellation.",
          evidence: ["qualification", "build-log"],
        },
      ],
    },
  };
  if (fault === "cleanup failure") {
    job.steps[4]!.conclusion = "failure";
  }
  if (fault === "test failure") {
    state.priorCi.jobs!.push({
      ...job,
      id: 606,
      name: "other-tests",
      steps: [step(1, "Product assertion", "failure", "20:40")],
    });
    evidence.cancellation.jobIds.push(606);
  }
  if (["success", "failure", "cancelled"].includes(fault)) {
    job.steps[2]!.conclusion = fault;
  }
  if (fault === "missing producer") {
    job.steps.splice(2, 1);
  }
  if (fault === "earlier upload") {
    job.steps[3]!.started_at = "2026-09-28T07:20:35Z";
  }
  if (fault === "missing time") {
    delete state.priorCi.jobs![2]!.steps![0]!.completed_at;
  }
  if (fault === "failed monitor") {
    state.priorCi.jobs![2]!.steps![0]!.conclusion = "failure";
  }
  if (fault === "wrong step") {
    evidence.cancellation.secondaryFailures[0]!.step = 12;
  }
  if (fault === "duplicate secondary") {
    evidence.cancellation.secondaryFailures.push({
      ...evidence.cancellation.secondaryFailures[0]!,
    });
  }
  if (fault === "relabel root") {
    evidence.cancellation.causedBy.push(job.id);
  }
  if (fault === "unbound log") {
    evidence.cancellation.secondaryFailures[0]!.evidence = ["qualification"];
  }
  if (fault === "changed log") {
    writeFileSync(log, "changed\n");
  }
  f.save(state);
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}

describePosix("prior-CI skipped-producer secondary failure", () => {
  it("lands only the qualified secondary upload while preserving roots and cancelled coverage", () => {
    const f = secondaryCandidate();
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    const proof = f.record().priorCiAdmin;
    expect(proof.failures.map((failure: { jobId: number }) => failure.jobId)).toEqual([601]);
    expect(proof.cancelledJobIds).toEqual([604]);
    expect(proof.aggregate.causedBy).toEqual([601]);
    expect(proof.cancellation.causedBy).toEqual([601]);
    expect(proof.cancellation.secondaryFailures).toEqual([
      expect.objectContaining({
        jobId: 604,
        step: 13,
        producerStep: 12,
        workflowBlob: f.git(["rev-parse", `${f.base}:.github/workflows/ci.yml`]),
        logSha256: f.evidence.artifacts[1]!.sha256,
      }),
    ]);
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
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });
});

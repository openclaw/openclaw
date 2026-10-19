import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import {
  expectExit,
  expectPriorCiRefusal,
  completedStep,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function timeoutCandidate(source = "jobs: {}\n", cancelled?: boolean) {
  const f = preExistingCandidate(source);
  const live = f.state();
  const deadline = live.priorCi.deadline;
  const check = deadline.check;
  check.head_sha = f.head;
  if (cancelled !== undefined) {
    Object.assign(check, {
      name: "check-additional-extension-package-boundary",
      completed_at: "2026-09-20T00:20:30Z",
      output: { annotations_count: cancelled ? 2 : 1 },
    });
    deadline.annotations[0]!.message = "The job has exceeded the maximum execution time of 20m0s";
    if (!cancelled) {
      deadline.annotations.pop();
    }
  }
  const job = live.priorCi.jobs![0]!;
  Object.assign(job, {
    ...(cancelled === undefined ? {} : { name: check.name }),
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps:
      cancelled === undefined
        ? [completedStep(18, "Run Node test shard", "cancelled")]
        : [
            completedStep(1, "Set up job", "success", check.started_at, "2026-09-20T00:00:05Z"),
            completedStep(
              10,
              "Run additional check shard",
              cancelled ? "cancelled" : "success",
              "2026-09-20T00:01:00Z",
              "2026-09-20T00:20:25Z",
            ),
            completedStep(
              27,
              "Complete job",
              "success",
              "2026-09-20T00:20:29Z",
              check.completed_at,
            ),
          ],
  });
  live.priorCi.jobs = live.priorCi.jobs!.filter((entry) => entry.id !== 604);
  const { cancellation: _cancellation, ...evidence } = f.evidence;
  f.save(live);
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, live, deadline, evidence, job, steps: job.steps! };
}

function boundaryTimeoutCandidate(cancelled: boolean, sourceFault?: string) {
  const owner = JSON.parse(
    readFileSync(
      new URL("../fixtures/ci/prior-boundary-deadline-owner.json", import.meta.url),
      "utf8",
    ),
  );
  owner["timeout-minutes"] = sourceFault === "different workflow budget" ? 30 : 20;
  if (sourceFault === "different workflow command") {
    owner.steps.find((step: { name: string }) => step.name === "Run additional check shard").run +=
      "echo changed\n";
  }
  return timeoutCandidate(stringify({ jobs: { "check-additional-shard": owner } }), cancelled);
}

describePosix("pre-existing job deadline admission", () => {
  it.each(["boundary success", "boundary cancelled", "Node cancelled"])(
    "retains the qualified %s deadline as failed evidence",
    (kind) => {
      const boundary = kind !== "Node cancelled";
      const cancelled = kind === "boundary cancelled";
      const f = boundary ? boundaryTimeoutCandidate(cancelled) : timeoutCandidate();
      const result = expectExit(boundary ? f.verifyPriorCi(f.path) : f.adminPriorCi(f.path), 0);
      const proof = boundary ? JSON.parse(result.stdout) : f.record().priorCiAdmin;
      expect(proof).toMatchObject({
        failures: [
          {
            jobId: 601,
            deadline: {
              conclusion: "cancelled",
              seconds: boundary ? 1200 : 3600,
              ...(boundary
                ? {
                    workflowJob: "check-additional-shard",
                    step: { number: 10, conclusion: cancelled ? "cancelled" : "success" },
                  }
                : { checkRunId: 601 }),
            },
          },
        ],
        cancelledJobIds: [],
      });
      expect(f.state().mutations).toBe(boundary ? 0 : 1);
    },
  );

  const boundaryFaults: Record<
    string,
    (f: ReturnType<typeof boundaryTimeoutCandidate>) => unknown
  > = {
    "success with cancellation annotation": ({ deadline }) => {
      deadline.annotations.push({
        ...deadline.annotations[0]!,
        message: "The operation was canceled.",
      });
      deadline.check.output.annotations_count = 2;
    },
    "cancelled without cancellation annotation": ({ deadline }) => {
      deadline.annotations.pop();
      deadline.check.output.annotations_count = 1;
    },
    "different workflow budget": () => undefined,
    "different workflow command": () => undefined,
    "wrong job name": ({ job, deadline }) => {
      job.name = "unrelated-check";
      deadline.check.name = "unrelated-check";
    },
    "wrong step ordinal": ({ steps }) => (steps[1]!.number = 11),
    "duplicate step number": ({ steps }) => (steps[2]!.number = 10),
    "another failed step": ({ steps }) => (steps[0]!.conclusion = "failure"),
    "another cancelled step": ({ steps }) => (steps[0]!.conclusion = "cancelled"),
    "missing cleanup": ({ steps }) => steps.pop(),
    "missing step timestamp": ({ steps }) => (steps[1]!.started_at = undefined),
    "reversed step times": ({ steps }) => (steps[1]!.started_at = "2026-09-20T00:20:26Z"),
    "step outside job": ({ steps }) => (steps[2]!.completed_at = "2026-09-20T00:20:31Z"),
    "shard ends before deadline": ({ steps }) => (steps[1]!.completed_at = "2026-09-20T00:19:59Z"),
    "extra annotation": ({ deadline }) => {
      deadline.annotations.push({ ...deadline.annotations[0]! });
      deadline.check.output.annotations_count = 2;
    },
    "wrong annotation duration": ({ deadline }) =>
      (deadline.annotations[0]!.message =
        "The job has exceeded the maximum execution time of 19m0s"),
    "missing independent qualification": ({ evidence }) => (evidence.failures[0]!.evidence = []),
    "aggregate omits root": ({ evidence }) => (evidence.aggregate.causedBy = []),
  };
  it.each(Object.entries(boundaryFaults))(
    "refuses boundary %s without dispatch",
    (fault, mutate) => {
      const f = boundaryTimeoutCandidate(
        fault === "cancelled without cancellation annotation",
        fault,
      );
      mutate(f);
      f.save(f.live);
      writeFileSync(f.path, JSON.stringify(f.evidence));
      expectPriorCiRefusal(f, /Prior-CI admin admission:/u);
    },
  );

  const nodeFaults: Record<string, (f: ReturnType<typeof timeoutCandidate>) => unknown> = {
    "manual cancellation": ({ deadline }) =>
      (deadline.annotations[0]!.message = "Cancelled by user"),
    "foreign publisher": ({ deadline }) => (deadline.check.app.id = 999),
    "stale head": (f) => (f.deadline.check.head_sha = f.base),
    "foreign suite": ({ deadline }) => (deadline.check.check_suite.id = 999),
    "incomplete annotations": ({ deadline }) => deadline.annotations.pop(),
    "short duration": ({ deadline, live }) => {
      deadline.check.completed_at = "2026-09-20T00:30:00Z";
      live.priorCi.jobs![0]!.completed_at = deadline.check.completed_at;
    },
    "additional failed step": ({ live }) =>
      live.priorCi.jobs![0]!.steps!.push(completedStep(19, "Other assertion", "failure")),
  };
  it.each(Object.entries(nodeFaults))("refuses %s without dispatch", (_fault, mutate) => {
    const f = timeoutCandidate();
    mutate(f);
    f.save(f.live);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    expectPriorCiRefusal(f, "deadline");
  });
});

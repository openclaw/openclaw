import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyReleaseSnapshot,
  terminalPolicyPass,
} from "../../scripts/full-release-validation-policy.mjs";
import { readChild } from "../../scripts/full-release-validation-state.mjs";
import { RELEASE_VALIDATION_WAIVERS } from "../../scripts/lib/release-validation-waivers.mjs";
import { child, githubRun } from "./full-release-validation-state.test-support.js";

const VERSION = "2026.10.19";
const ROLE = "releaseChecksIndependent";
const LIVE_JOB =
  "Run repo/live E2E validation / Native live suites (Native live gateway profiles OpenAI)";
const PACKAGE_JOB =
  "Run package acceptance / Telegram package acceptance / Run package Telegram E2E";
const TOP_AGGREGATE = "Verify release checks";
const PACKAGE_AGGREGATE = "Run package acceptance / Verify package acceptance";
const LIVE_FAILURE_LOG =
  "2026-10-19T00:00:00Z ##[error]live_repo_e2e_release_checks ended with failure\n" +
  "2026-10-19T00:00:00Z ##[error]Process completed with exit code 1.\n";
const originalWaivers = [...RELEASE_VALIDATION_WAIVERS];
const REASON = "Synthetic release-tooling approval for a known provider outage.";

type Job = {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
};

function job(name: string, id: number, overrides: Partial<Job> = {}): Job {
  return { id, name, status: "completed", conclusion: "failure", steps: [], ...overrides };
}

function aggregate(name = TOP_AGGREGATE, id = 2): Job {
  return job(name, id, {
    steps: [
      {
        name:
          name === PACKAGE_AGGREGATE
            ? "Verify package acceptance results"
            : "Verify release check results",
        conclusion: "failure",
      },
    ],
  });
}

function grant(jobName = LIVE_JOB, childRole = ROLE) {
  RELEASE_VALIDATION_WAIVERS.push({
    targetVersion: VERSION,
    childRole,
    jobName,
    reason: REASON,
  });
}

async function observe(
  jobs: Job[],
  role = ROLE,
  logs: Record<string, string> = { "2": LIVE_FAILURE_LOG },
) {
  vi.stubEnv("GITHUB_REPOSITORY", "openclaw/openclaw");
  const planned = child(role, { workflow: "openclaw-release-checks.yml" });
  return readChild(planned, undefined, undefined, {
    targetVersion: VERSION,
    readRun: async () =>
      githubRun(planned, {
        conclusion: "failure",
        path: ".github/workflows/openclaw-release-checks.yml",
      }),
    readAttemptJobs: async () => jobs,
    readJobLog: async (id: number) => {
      const log = logs[String(id)];
      if (log === undefined) {
        throw new Error(`Unexpected aggregate log request: ${id}`);
      }
      return log;
    },
  });
}

afterEach(() => {
  RELEASE_VALIDATION_WAIVERS.splice(0, RELEASE_VALIDATION_WAIVERS.length, ...originalWaivers);
  vi.unstubAllEnvs();
});

function classify(observed: Awaited<ReturnType<typeof observe>>) {
  return classifyReleaseSnapshot({ children: [observed], targetVersion: VERSION });
}

describe("checked-in release-tooling waivers", () => {
  it("composes provider waivers with Windows-node preview advisories", async () => {
    grant(LIVE_JOB, "releaseChecksCandidate");
    const observed = await observe(
      [
        job(LIVE_JOB, 1),
        aggregate(),
        job("Run Windows-node stable E2E / Setup, connect, and invoke candidate gateway", 3, {
          conclusion: "success",
        }),
        job("Run Windows-node main E2E / Setup, connect, and invoke candidate gateway", 4),
      ],
      "releaseChecksCandidate",
    );
    expect(observed.errors).toEqual([]);
    expect(terminalPolicyPass(observed, VERSION)).toBe(true);
    expect(classify(observed)).toMatchObject({
      state: "passed",
      blockers: [],
      waivers: [{ jobName: LIVE_JOB }],
      advisoryJobs: [{ class: "windows-node-preview", conclusion: "failure" }],
    });
  });

  it.each<{
    name: string;
    leaf?: Partial<Job> | null;
  }>([
    { name: "a cancelled leaf", leaf: { conclusion: "cancelled" } },
    { name: "a skipped leaf", leaf: { conclusion: "skipped" } },
    { name: "an unfinished leaf", leaf: { status: "in_progress", conclusion: "" } },
    { name: "a missing leaf", leaf: null },
  ])("does not apply a grant to $name", async ({ leaf }) => {
    grant();
    const jobs = [...(leaf === null ? [] : [job(LIVE_JOB, 1, leaf)]), aggregate()];
    const observed = await observe(jobs);
    const decision = classify(observed);
    expect(observed.errors).toEqual([]);
    expect(decision).toMatchObject({ waivers: [], state: "blocked_complete" });
  });

  it.each<{ name: string; log?: string; summary?: Job; error: string }>([
    {
      name: "an extra evidence-integrity failure",
      log: `${LIVE_FAILURE_LOG}::error::Advisory evidence resolution or validation failed.\n`,
      error: "unwaived failure",
    },
    {
      name: "an unrelated failed setup step",
      summary: { ...aggregate(), steps: [{ name: "Set up job", conclusion: "failure" }] },
      error: "non-policy failure",
    },
    {
      name: "an unexplained policy-step failure",
      log: "::error::Process completed with exit code 1.\n",
      error: "unwaived failure",
    },
    {
      name: "a cancelled aggregate",
      summary: { ...aggregate(), conclusion: "cancelled" },
      error: "non-policy failure",
    },
  ])("does not excuse $name", async ({ log = LIVE_FAILURE_LOG, summary = aggregate(), error }) => {
    grant();
    const observed = await observe([job(LIVE_JOB, 1), summary], ROLE, { "2": log });
    expect(observed.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining(error) }),
    ]);
    expect(classify(observed).state).toBe("orchestration_error");
  });

  it("does not accept a waived leaf without its required aggregate", async () => {
    grant();
    const observed = await observe([job(LIVE_JOB, 1)]);
    expect(observed.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("aggregate is missing") }),
    ]);
  });

  it.each(["success", "failure"])(
    "handles both package aggregates while package integrity is %s",
    async (integrityConclusion) => {
      grant(PACKAGE_JOB, "releaseChecksCandidate");
      const observed = await observe(
        [
          job(PACKAGE_JOB, 1),
          aggregate(),
          aggregate(PACKAGE_AGGREGATE, 3),
          job("Run package acceptance / Package integrity", 4, { conclusion: integrityConclusion }),
        ],
        "releaseChecksCandidate",
        {
          "2": "::error::package_acceptance_release_checks ended with failure\n",
          "3": "::error::package_telegram ended with failure\n",
        },
      );
      expect(observed.errors).toEqual([]);
      expect(observed.jobs).toContainEqual(
        expect.objectContaining({ name: PACKAGE_JOB, conclusion: "failure" }),
      );
      const decision = classify(observed);
      expect(decision.state).toBe(
        integrityConclusion === "success" ? "passed" : "blocked_complete",
      );
      if (integrityConclusion === "failure") {
        expect(decision.blockers).toContainEqual(
          expect.objectContaining({ job: "Run package acceptance / Package integrity" }),
        );
      }
    },
  );
});

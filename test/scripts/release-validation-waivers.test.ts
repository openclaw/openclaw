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
      { name: "Set up job", conclusion: "success" },
      {
        name:
          name === PACKAGE_AGGREGATE
            ? "Verify package acceptance results"
            : "Verify release check results",
        conclusion: "failure",
      },
      { name: "Complete job", conclusion: "success" },
    ],
  });
}

function grant(jobName = LIVE_JOB, childRole = ROLE) {
  RELEASE_VALIDATION_WAIVERS.push({
    targetVersion: VERSION,
    childRole,
    jobName,
    reason: "Synthetic release-tooling approval for a known provider outage.",
  });
}

async function observe(
  jobs: Job[],
  {
    targetVersion = VERSION,
    role = ROLE,
    logs = { "2": LIVE_FAILURE_LOG },
  }: { targetVersion?: string; role?: string; logs?: Record<string, string> } = {},
) {
  vi.stubEnv("GITHUB_REPOSITORY", "openclaw/openclaw");
  const planned = child(role, { workflow: "openclaw-release-checks.yml" });
  return readChild(planned, undefined, undefined, {
    targetVersion,
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

describe("checked-in release-tooling waivers", () => {
  it("passes the aggregate decision while retaining the failed child and leaf evidence", async () => {
    grant();
    const observed = await observe([job(LIVE_JOB, 1), aggregate()]);
    expect(observed.errors).toEqual([]);
    expect(observed.conclusion).toBe("failure");
    expect(observed.jobs).toContainEqual(
      expect.objectContaining({ name: LIVE_JOB, status: "completed", conclusion: "failure" }),
    );
    expect(terminalPolicyPass(observed, VERSION)).toBe(true);
    expect(classifyReleaseSnapshot({ children: [observed], targetVersion: VERSION })).toMatchObject(
      {
        state: "passed",
        blockers: [],
        waivers: [
          {
            targetVersion: VERSION,
            childRole: ROLE,
            jobName: LIVE_JOB,
            reason: "Synthetic release-tooling approval for a known provider outage.",
            runId: "101",
            runAttempt: 1,
          },
        ],
      },
    );
  });

  it.each<{
    name: string;
    targetVersion?: string;
    role?: string;
    leaf?: Partial<Job> | null;
  }>([
    { name: "another release version", targetVersion: "2026.10.20" },
    { name: "another child role", role: "releaseChecksCandidate" },
    { name: "another job name", leaf: { name: `${LIVE_JOB} extra` } },
    { name: "a cancelled leaf", leaf: { conclusion: "cancelled" } },
    { name: "a timed-out leaf", leaf: { conclusion: "timed_out" } },
    { name: "a skipped leaf", leaf: { conclusion: "skipped" } },
    { name: "an unfinished leaf", leaf: { status: "in_progress", conclusion: "" } },
    { name: "a missing leaf", leaf: null },
  ])("does not apply a grant to $name", async ({ targetVersion = VERSION, role, leaf }) => {
    grant();
    const jobs = [...(leaf === null ? [] : [job(LIVE_JOB, 1, leaf)]), aggregate()];
    const observed = await observe(jobs, { targetVersion, role });
    const decision = classifyReleaseSnapshot({ children: [observed], targetVersion });
    expect(observed.errors).toEqual([]);
    expect(decision.waivers).toEqual([]);
    expect(decision.state).toBe("blocked_complete");
  });

  it.each([
    {
      name: "an extra evidence-integrity failure",
      log: `${LIVE_FAILURE_LOG}::error::Advisory evidence resolution or validation failed.\n`,
      aggregate: aggregate(),
      error: "unwaived failure",
    },
    {
      name: "an unverified Telegram dispatch identity",
      log: `${LIVE_FAILURE_LOG}::error::Telegram dispatch identity was not verified\n`,
      aggregate: aggregate(),
      error: "unwaived failure",
    },
    {
      name: "an unrelated failed setup step",
      log: LIVE_FAILURE_LOG,
      aggregate: { ...aggregate(), steps: [{ name: "Set up job", conclusion: "failure" }] },
      error: "non-policy failure",
    },
    {
      name: "an unexplained policy-step failure",
      log: "::error::Process completed with exit code 1.\n",
      aggregate: aggregate(),
      error: "unwaived failure",
    },
    {
      name: "a cancelled aggregate",
      log: LIVE_FAILURE_LOG,
      aggregate: { ...aggregate(), conclusion: "cancelled" },
      error: "non-policy failure",
    },
  ])("does not excuse $name", async ({ log, aggregate: summary, error }) => {
    grant();
    const observed = await observe([job(LIVE_JOB, 1), summary], { logs: { "2": log } });
    expect(observed.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining(error) }),
    ]);
    expect(classifyReleaseSnapshot({ children: [observed], targetVersion: VERSION }).state).toBe(
      "orchestration_error",
    );
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
        {
          role: "releaseChecksCandidate",
          logs: {
            "2": "::error::package_acceptance_release_checks ended with failure\n",
            "3": "::error::package_telegram ended with failure\n",
          },
        },
      );
      expect(observed.errors).toEqual([]);
      expect(observed.jobs).toContainEqual(
        expect.objectContaining({ name: PACKAGE_JOB, conclusion: "failure" }),
      );
      const decision = classifyReleaseSnapshot({ children: [observed], targetVersion: VERSION });
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

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyReleaseSnapshot,
  releaseChildSpec,
  terminalPolicyPass,
} from "../../scripts/full-release-validation-policy.mjs";
import { readChild } from "../../scripts/full-release-validation-state.mjs";
import { RELEASE_VALIDATION_WAIVERS } from "../../scripts/lib/release-validation-waivers.mjs";
import { withRuntimePreload } from "../helpers/runtime-preload.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  child,
  collectorEnv,
  canonicalCandidateRequest,
  executionPlan,
  githubRun,
  runCollector,
} from "./full-release-validation-state.test-support.js";

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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      { role: "releaseChecksCandidate" },
    );
    expect(observed.errors).toEqual([]);
    expect(terminalPolicyPass(observed, VERSION)).toBe(true);
    expect(classifyReleaseSnapshot({ children: [observed], targetVersion: VERSION })).toMatchObject(
      {
        state: "passed",
        blockers: [],
        waivers: [{ jobName: LIVE_JOB }],
        advisoryJobs: [{ class: "windows-node-preview", conclusion: "failure" }],
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
    const jobs = [job(LIVE_JOB, 1), summary, job("Unwaived QA lane", 3)];
    const observed = await observe(jobs, { logs: { "2": log } });
    expect(observed).toMatchObject({
      status: "completed",
      conclusion: "failure",
      observedRunAttempts: [1],
      compositeJobsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(observed.jobs).toHaveLength(jobs.length);
    expect(observed.jobs).toEqual(
      expect.arrayContaining(jobs.map(({ name }) => expect.objectContaining({ name }))),
    );
    expect(observed.errors).toEqual([
      expect.objectContaining({
        kind: "aggregate_validation",
        message: expect.stringContaining(error),
      }),
    ]);
    expect(classifyReleaseSnapshot({ children: [observed], targetVersion: VERSION })).toMatchObject(
      {
        state: "orchestration_error",
        activeRunIds: [],
        blockers: expect.arrayContaining([expect.objectContaining({ job: "Unwaived QA lane" })]),
      },
    );
  });

  it.each(["aggregate", "log", "provenance"] as const)(
    "drains active siblings only for an aggregate verdict, not a %s read failure",
    (failure) => {
      grant();
      const root = tempDirs.make("frv-waiver-drain-");
      const output = join(root, "drain.json");
      const planPath = join(root, "plan.json");
      const callsPath = join(root, "calls");
      const gh = join(root, "gh");
      const preload = join(root, "waiver.mjs");
      const sealed = executionPlan(
        {
          childPhaseVersion: 3,
          children: {
            normalCi: { result: "success", runAttempt: 1, runId: "101" },
            releaseChecksIndependent: { result: "success", runAttempt: 1, runId: "303" },
          },
        },
        {
          attemptEvidenceVersion: 3,
          candidateRequest: canonicalCandidateRequest(),
          targetVersion: VERSION,
        },
      );
      const runs = Object.fromEntries(
        sealed.children
          .filter((entry) => entry.runId)
          .map((entry) => [
            entry.runId,
            githubRun(child(entry.key, entry), {
              id: Number(entry.runId),
              path: `.github/workflows/${releaseChildSpec(entry.key).workflow}`,
              conclusion: entry.runId === "303" ? "failure" : "success",
              ...(failure === "provenance" && entry.runId === "303"
                ? { head_sha: "c".repeat(40) }
                : {}),
            }),
          ]),
      );
      writeFileSync(planPath, JSON.stringify(sealed));
      writeFileSync(callsPath, "");
      writeFileSync(
        preload,
        `import { RELEASE_VALIDATION_WAIVERS } from ${JSON.stringify(new URL("../../scripts/lib/release-validation-waivers.mjs", import.meta.url).href)};\nRELEASE_VALIDATION_WAIVERS.push(${JSON.stringify(RELEASE_VALIDATION_WAIVERS.at(-1))});\n`,
      );
      writeFileSync(
        gh,
        `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FRV_GH_CALLS, JSON.stringify(args) + "\\n");
const endpoint = args.find((arg) => arg.startsWith("repos/"));
const observations = readFileSync(process.env.FRV_GH_CALLS, "utf8").trim().split("\\n").map(JSON.parse);
const completed = observations.filter((args) => args.includes("repos/openclaw/openclaw/actions/runs/101")).length > 1;
const runs = ${JSON.stringify(runs)};
if (endpoint === "repos/openclaw/openclaw/actions/jobs/2/logs") {
  if (${JSON.stringify(failure)} === "log") { console.error("HTTP 403 fixture aggregate log denied"); process.exit(1); }
  console.log(${JSON.stringify(`${LIVE_FAILURE_LOG}::error::Unwaived QA lane failed\n`)});
} else if (endpoint?.includes("/attempts/1/jobs?")) {
  const jobs = endpoint.includes("/303/")
    ? ${JSON.stringify([job(LIVE_JOB, 1), aggregate(), job("Unwaived QA lane", 3)])}
    : [{ name: "test", status: completed ? "completed" : "in_progress", conclusion: completed ? "success" : null }];
  for (const job of jobs) console.log(JSON.stringify(job));
} else if (endpoint?.endsWith("/runs/101")) {
  console.log(JSON.stringify({ ...runs["101"], status: completed ? "completed" : "in_progress", conclusion: completed ? "success" : null }));
} else if (endpoint?.endsWith("/runs/303")) {
  console.log(JSON.stringify(runs["303"]));
} else { console.error("Unexpected fixture request: " + args.join(" ")); process.exit(1); }
`,
      );
      chmodSync(gh, 0o755);
      const result = runCollector("drain", {
        ...withRuntimePreload(collectorEnv({}), preload),
        FAIL_FAST: "false",
        FRV_GH_CALLS: callsPath,
        FULL_RELEASE_EXECUTION_PLAN_PATH: planPath,
        FULL_RELEASE_POLL_INTERVAL_MS: "1",
        FULL_RELEASE_STATE_PATH: output,
        PATH: `${root}:${process.env.PATH}`,
        RERUN_GROUP: "all",
      });
      expect(result.status, result.stderr).toBe(2);
      const artifact = JSON.parse(readFileSync(output, "utf8"));
      expect(artifact.state).toBe("orchestration_error");
      const calls: string[][] = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.filter((args) => args.includes("repos/openclaw/openclaw/actions/runs/101")),
      ).toHaveLength(failure === "aggregate" ? 2 : 1);
      expect(calls.every((args) => args[0] === "api")).toBe(true);
      if (failure === "aggregate") {
        expect(artifact.activeRunIds).toEqual([]);
        expect(artifact.children.releaseChecksIndependent.timing.jobs).toHaveLength(3);
        expect(artifact.children.releaseChecksIndependent.status).toBe("completed");
        expect(artifact.errors).toContainEqual(
          expect.objectContaining({ kind: "aggregate_validation" }),
        );
        expect(artifact.blockers).toContainEqual(
          expect.objectContaining({ job: "Unwaived QA lane" }),
        );
      } else {
        expect(artifact.activeRunIds).toContain("101");
        expect(artifact.errors).toContainEqual(
          expect.objectContaining({
            kind: failure === "log" ? "api_error" : "provenance_mismatch",
          }),
        );
      }
    },
  );

  it("grants the Kova leaf only for the operator-named version", () => {
    const failed = (key: string) =>
      child(key, {
        conclusion: "failure",
        jobs: [job("Kova mock provider performance", 1)],
        status: "completed",
      });
    expect(terminalPolicyPass(failed("productPerformance"), "2026.11.1")).toBe(true);
    expect(terminalPolicyPass(failed("productPerformance"), "2026.11.2")).toBe(false);
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

import { describe, expect, it } from "vitest";
import {
  terminalPolicyPass,
  validateReleaseManifestAdvisoryJobs,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  evaluateReleaseChildPolicy,
  validateReleaseWaiverAggregates,
} from "../../scripts/lib/release-validation-waivers.mjs";

const version = "2026.11.5-beta.3";
const jobs = [
  "checks-ui (3/3)",
  "android-screenshots",
  "checks-node-agentic-agents-core-runtime",
  "checks-node-agentic-control-plane-runtime-state",
].map((name, id) => ({ id, name, status: "completed", conclusion: "failure" }));
const child = { key: "normalCi", status: "completed", conclusion: "failure", jobs };

describe("beta.3 operator-accepted failures", () => {
  it("admits only named failures through the decision and manifest readers, preserving raw results", () => {
    expect(terminalPolicyPass(child, version)).toBe(true);
    expect(() =>
      validateReleaseManifestAdvisoryJobs({
        validationInputs: { targetVersion: version },
        childEvidence: { normalCi: child },
      }),
    ).not.toThrow();
    expect(jobs.every((job) => job.conclusion === "failure")).toBe(true);
    expect(terminalPolicyPass(child, "2026.11.5-beta.4")).toBe(false);
    expect(
      terminalPolicyPass(
        {
          ...child,
          jobs: [
            ...jobs,
            { id: 9, name: "build-artifacts", status: "completed", conclusion: "failure" },
          ],
        },
        version,
      ),
    ).toBe(false);
    expect(
      terminalPolicyPass({ ...child, jobs: [{ ...jobs[0], conclusion: "cancelled" }] }, version),
    ).toBe(false);
  });

  it("validates exact CI aggregate causes rather than excusing integrity failures", async () => {
    const aggregate = gate;
    const policy = evaluateReleaseChildPolicy({
      child: { ...child, jobs: [...jobs, aggregate] },
      targetVersion: version,
    });
    const cause = "##[error]checks-ui finished with failure (selected=true)";
    await expect(
      validateReleaseWaiverAggregates({
        policy,
        jobs: [...jobs, aggregate],
        getJobLog: () => cause,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateReleaseWaiverAggregates({
        policy,
        jobs: [...jobs, aggregate],
        getJobLog: () => cause + "\n##[error]build-artifacts finished with failure (selected=true)",
      }),
    ).rejects.toThrow("unwaived failure");
    await expect(
      validateReleaseWaiverAggregates({
        policy,
        jobs: [...jobs, { ...aggregate, steps: [{ name: "Checkout", conclusion: "failure" }] }],
        getJobLog: () => cause,
      }),
    ).rejects.toThrow("non-policy failure");
  });

  it("admits the named Docker test job but not other package or receipt failures", () => {
    const docker = {
      ...child,
      key: "releaseChecksCandidate",
      jobs: [
        {
          ...jobs[0],
          name: "Run Docker release-path validation / Docker E2E (package/update OpenAI)",
        },
      ],
    };
    expect(terminalPolicyPass(docker, version)).toBe(true);
    expect(
      terminalPolicyPass(
        {
          ...docker,
          jobs: [...docker.jobs, { ...jobs[0], name: "Seal artifact producer receipt" }],
        },
        version,
      ),
    ).toBe(false);
  });
});

const stableVersion = "2026.11.4";
const targetSha = "5eb2d8052ddc363245bea3ca4ec0833815ab6e93";
const stableNames = [
  "checks-node-agentic-control-plane-runtime-state",
  "checks-ui-e2e-real-gateway (1/2)",
  "macos-swift (tests)",
];
const stableCauses = [
  "checks-node-core-test-nondist-shard finished with failure (selected=true)",
  "checks-ui-e2e-real-gateway finished with failure (selected=true)",
  "macos-swift finished with failure (selected=true)",
];
const failedJob = { status: "completed", conclusion: "failure" };
const stableJobs = stableNames.map((name, id) => ({ ...failedJob, id, name }));
const gate = {
  id: 10,
  name: "openclaw/ci-gate",
  status: "completed",
  conclusion: "failure",
  steps: [{ name: "Verify selected CI lanes", conclusion: "failure" }],
};
const stableChild = { ...child, jobs: [...stableJobs, gate] };
const stableInput = { child: stableChild, targetVersion: stableVersion, targetSha };
const stableLog = stableCauses
  .map((cause) => "2026-11-15T04:00:00.0000000Z ::error title=CI job did not succeed::" + cause)
  .join("\n");

describe("2026.11.4 exact-candidate exceptions", () => {
  it.each(stableNames)("admits only the executed failure of %s on the fixed candidate", (name) => {
    const input = {
      ...stableInput,
      child: { ...child, jobs: stableJobs.filter((job) => job.name === name) },
    };
    expect(evaluateReleaseChildPolicy(input).waivers).toEqual([
      expect.objectContaining({
        targetSha,
        targetVersion: stableVersion,
        childRole: "normalCi",
        jobName: name,
      }),
    ]);
    for (const sha of [undefined, "005030c3a09843601af3de546dbff77240175a66", "a".repeat(40)]) {
      expect(evaluateReleaseChildPolicy({ ...input, targetSha: sha }).blockingJobs).toHaveLength(1);
    }
    const rejectedInputs = [
      { ...input, targetVersion: "2026.11.5" },
      { ...input, child: { ...input.child, key: "releaseChecksCandidate" } },
      ...["skipped", "cancelled", "timed_out", "neutral", "success"].map((conclusion) =>
        Object.assign({}, input, {
          child: { ...input.child, jobs: [{ status: "completed", name, conclusion }] },
        }),
      ),
    ];
    for (const rejected of rejectedInputs) {
      expect(evaluateReleaseChildPolicy(rejected).waivers).toEqual([]);
    }
  });

  it("retains raw results and rejects ungranted matrix siblings", () => {
    expect(terminalPolicyPass(stableChild, stableVersion, targetSha)).toBe(true);
    expect(() =>
      validateReleaseManifestAdvisoryJobs({
        targetSha,
        validationInputs: { targetVersion: stableVersion },
        childEvidence: { normalCi: stableChild },
      }),
    ).not.toThrow();
    expect(stableChild.conclusion).toBe("failure");
    expect(stableChild.jobs.every((job) => job.conclusion === "failure")).toBe(true);
    for (const name of [
      "checks-ui-e2e-real-gateway (2/2)",
      "macos-swift (build)",
      "checks-node-agentic-agents-core-runtime",
      "Seal artifact producer receipt",
    ]) {
      expect(
        terminalPolicyPass(
          { ...stableChild, jobs: [...stableChild.jobs, { ...gate, name }] },
          stableVersion,
          targetSha,
        ),
      ).toBe(false);
    }
    expect(() =>
      validateReleaseManifestAdvisoryJobs({
        targetSha: "a".repeat(40),
        validationInputs: { targetVersion: stableVersion },
        childEvidence: { normalCi: stableChild },
        waivers: evaluateReleaseChildPolicy(stableInput).waivers,
      }),
    ).toThrow("failed selected job");
    const kova = evaluateReleaseChildPolicy({
      child: {
        ...child,
        key: "productPerformance",
        jobs: [{ ...gate, name: "Kova mock provider performance" }],
      },
      targetVersion: stableVersion,
    });
    expect(kova.waivers).toHaveLength(1);
    expect(kova.waivers[0]).not.toHaveProperty("targetSha");
  });

  it("authenticates the exact cause union, including metadata annotations", async () => {
    const policy = evaluateReleaseChildPolicy(stableInput);
    expect(policy.waivers).toHaveLength(3);
    for (const log of [
      stableLog,
      stableCauses.map((cause) => "##[error]" + cause).join("\n"),
      stableLog + "\n##[error]Process completed with exit code 1.",
    ]) {
      await expect(
        validateReleaseWaiverAggregates({ policy, jobs: stableChild.jobs, getJobLog: () => log }),
      ).resolves.toBeUndefined();
    }
    const invalidLogs = [
      stableLog.split("\n").slice(1).join("\n"),
      stableLog + "\n##[error]unknown failure",
      stableLog + "\n\u001b[31m##[error]hidden failure\u001b[0m",
      stableLog + "\n::error malformed",
      stableLog + "\n" + stableLog.split("\n")[0],
      stableCauses.map((cause) => 'echo "::error::' + cause + '"').join("\n"),
      stableLog.replace("selected=true", "selected=false"),
      "",
    ];
    for (const log of invalidLogs) {
      await expect(
        validateReleaseWaiverAggregates({ policy, jobs: stableChild.jobs, getJobLog: () => log }),
      ).rejects.toThrow("unwaived failure");
    }
    await expect(
      validateReleaseWaiverAggregates({
        policy,
        jobs: stableChild.jobs,
        getJobLog: () => {
          throw new Error("log unavailable");
        },
      }),
    ).rejects.toThrow("log unavailable");
  });

  it("requires one terminal gate and its sole policy failure step", async () => {
    const policy = evaluateReleaseChildPolicy(stableInput);
    for (const gates of [
      [],
      [gate, gate],
      ...["skipped", "cancelled", "timed_out", "neutral"].map((conclusion) => [
        { ...gate, conclusion },
      ]),
      [{ ...gate, status: "in_progress" }],
      [{ ...gate, steps: [...gate.steps, { name: "Checkout", conclusion: "failure" }] }],
    ]) {
      await expect(
        validateReleaseWaiverAggregates({
          policy,
          jobs: [...stableJobs, ...gates],
          getJobLog: () => stableLog,
        }),
      ).rejects.toThrow();
    }
  });
});

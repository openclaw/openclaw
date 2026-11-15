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
    const aggregate = {
      id: 10,
      name: "openclaw/ci-gate",
      status: "completed",
      conclusion: "failure",
      steps: [{ name: "Verify selected CI lanes", conclusion: "failure" }],
    };
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

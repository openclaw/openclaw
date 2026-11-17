import { describe, expect, it } from "vitest";
import {
  terminalPolicyPass,
  validateReleaseManifestAdvisoryJobs,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  evaluateReleaseChildPolicy,
  releaseQualificationExemptions,
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

// Grant entries share the matching and rejection contract exercised above.
it.each([
  {
    sha: "e283dccf68ba35ef1af5b3fa31571db7f4b6bc74",
    role: "releaseChecksIndependent",
    names: ["Native live gateway core", "Native live test harnesses"].map(
      (suite) => `Run repo/live E2E validation / Native live suites (${suite})`,
    ),
    aggregate: "Verify release checks",
    step: "Verify release check results",
    cause: "live_repo_e2e_release_checks ended with failure",
  },
  {
    sha: "d843d6af39a42cd3c30084edbeabeece732fd93a",
    role: "normalCi",
    names: ["checks-node-agentic-gateway-server-isolated-4"],
    aggregate: "openclaw/ci-gate",
    step: "Verify selected CI lanes",
    cause: "checks-node-core-test-nondist-shard finished with failure (selected=true)",
  },
  {
    sha: "d843d6af39a42cd3c30084edbeabeece732fd93a",
    role: "releaseChecksIndependent",
    names: ["Run repo/live E2E validation / Native live suites (Native live gateway core)"],
    aggregate: "Verify release checks",
    step: "Verify release check results",
    cause: "live_repo_e2e_release_checks ended with failure",
  },
])("admits $role grants on $sha", async ({ sha, role, names, aggregate, step, cause }) => {
  const currentChild = {
    ...child,
    key: role,
    jobs: [
      ...names.map((name, id) => ({ ...failedJob, id, name })),
      { ...gate, name: aggregate, steps: [{ name: step, conclusion: "failure" }] },
    ],
  };
  const policy = evaluateReleaseChildPolicy({
    child: currentChild,
    targetVersion: stableVersion,
    targetSha: sha,
  });
  expect(policy.waivers.map((waiver) => waiver.jobName)).toEqual(names);
  expect(terminalPolicyPass(currentChild, stableVersion, sha)).toBe(true);
  expect(() =>
    validateReleaseManifestAdvisoryJobs({
      targetSha: sha,
      validationInputs: { targetVersion: stableVersion },
      childEvidence: { [role]: currentChild },
    }),
  ).not.toThrow();
  await expect(
    validateReleaseWaiverAggregates({
      policy,
      jobs: currentChild.jobs,
      getJobLog: () => "##[error]" + cause,
    }),
  ).resolves.toBeUndefined();
});

describe("2026.10.33 iOS screenshot exception", () => {
  const names = ["ios-screenshots-iphone", "ios-screenshots-ipad-13"];
  const iosJobs = names.map((name, id) => ({ ...failedJob, id, name }));
  const iosChild = { ...child, jobs: [...iosJobs, gate] };
  const input = { child: iosChild, targetVersion: "2026.10.33" };

  it("accepts only the two authorized screenshot jobs and preserves raw failures", () => {
    const policy = evaluateReleaseChildPolicy(input);
    expect(policy.waivers.map((row) => row.jobName)).toEqual(names);
    expect(terminalPolicyPass(iosChild, input.targetVersion)).toBe(true);
    expect(iosChild.jobs.every((job) => job.conclusion === "failure")).toBe(true);
    expect(evaluateReleaseChildPolicy({ ...input, targetVersion: "2026.10.34" }).waivers).toEqual(
      [],
    );
    expect(
      evaluateReleaseChildPolicy({
        ...input,
        child: { ...iosChild, key: "releaseChecksCandidate" },
      }).waivers,
    ).toEqual([]);
    for (const name of [
      "ios-build",
      "ios-screenshot-evidence",
      "docker-seed-e2e",
      "Seal artifact producer receipt",
    ]) {
      expect(
        terminalPolicyPass(
          { ...iosChild, jobs: [...iosChild.jobs, { ...failedJob, name }] },
          input.targetVersion,
        ),
      ).toBe(false);
    }
    for (const conclusion of ["cancelled", "timed_out"]) {
      expect(
        terminalPolicyPass(
          { ...iosChild, jobs: [{ ...iosJobs[0], conclusion }] },
          input.targetVersion,
        ),
      ).toBe(false);
    }
  });

  it("requires the exact screenshot aggregate cause without excusing other failures", async () => {
    const policy = evaluateReleaseChildPolicy(input);
    expect(policy.waivers).toHaveLength(2);
    const log =
      "::error title=CI job did not succeed::ios-screenshot-shard finished with failure (selected=true)";
    await expect(
      validateReleaseWaiverAggregates({ policy, jobs: iosChild.jobs, getJobLog: () => log }),
    ).resolves.toBeUndefined();
    await expect(
      validateReleaseWaiverAggregates({
        policy,
        jobs: iosChild.jobs,
        getJobLog: () => log + "\n##[error]docker-seed-e2e finished with failure (selected=true)",
      }),
    ).rejects.toThrow("unwaived failure");
    await expect(
      validateReleaseWaiverAggregates({ policy, jobs: iosChild.jobs, getJobLog: () => "" }),
    ).rejects.toThrow("unwaived failure");
  });
});

it.each(["2026.10.33", "2026.11.5"])(
  "admits only the authorized %s Kova failure without skipping qualification",
  (targetVersion) => {
    const kova = {
      ...child,
      key: "productPerformance",
      jobs: [{ ...failedJob, id: 133410712957, name: "Kova mock provider performance" }],
    };
    expect(terminalPolicyPass(kova, targetVersion)).toBe(true);
    expect(kova.conclusion).toBe("failure");
    expect(kova.jobs).toMatchObject([{ conclusion: "failure" }]);
    expect(releaseQualificationExemptions(targetVersion, "stable")).toEqual([]);
    expect(terminalPolicyPass(kova, "2026.11.6")).toBe(false);
    expect(terminalPolicyPass({ ...kova, key: "normalCi" }, targetVersion)).toBe(false);
    for (const conclusion of ["cancelled", "timed_out"]) {
      expect(
        terminalPolicyPass({ ...kova, jobs: [{ ...kova.jobs[0], conclusion }] }, targetVersion),
      ).toBe(false);
    }
    expect(
      terminalPolicyPass(
        { ...kova, jobs: [...kova.jobs, { ...failedJob, id: 2, name: "Build candidate" }] },
        targetVersion,
      ),
    ).toBe(false);
  },
);

it("admits only the authorized 2026.11.5 Telegram package failure", async () => {
  const name = "Run package acceptance / Telegram package acceptance / Run package Telegram E2E";
  const telegram = {
    ...child,
    key: "releaseChecksCandidate",
    jobs: [{ ...failedJob, id: 133430641645, name }],
  };
  expect(terminalPolicyPass(telegram, "2026.11.5")).toBe(true);
  expect(telegram.jobs).toMatchObject([{ conclusion: "failure" }]);
  expect(terminalPolicyPass(telegram, "2026.11.6")).toBe(false);
  expect(terminalPolicyPass({ ...telegram, key: "normalCi" }, "2026.11.5")).toBe(false);
  expect(releaseQualificationExemptions("2026.11.5", "stable")).toEqual([]);
  for (const conclusion of ["cancelled", "timed_out", "skipped"]) {
    expect(
      terminalPolicyPass({ ...telegram, jobs: [{ ...failedJob, name, conclusion }] }, "2026.11.5"),
    ).toBe(false);
  }
  expect(
    terminalPolicyPass(
      {
        ...telegram,
        jobs: [
          ...telegram.jobs,
          {
            ...failedJob,
            name: "Run repo/live E2E validation / Native live suites (Native live gateway core)",
          },
        ],
      },
      "2026.11.5",
    ),
  ).toBe(false);
  const aggregates = [
    {
      ...gate,
      id: 11,
      name: "Run package acceptance / Verify package acceptance",
      steps: [{ name: "Verify package acceptance results", conclusion: "failure" }],
    },
    {
      ...gate,
      name: "Verify release checks",
      steps: [{ name: "Verify release check results", conclusion: "failure" }],
    },
  ];
  const allJobs = [...telegram.jobs, ...aggregates];
  const policy = evaluateReleaseChildPolicy({
    child: { ...telegram, jobs: allJobs },
    targetVersion: "2026.11.5",
  });
  await expect(
    validateReleaseWaiverAggregates({
      policy,
      jobs: allJobs,
      getJobLog: (id) =>
        id === 11
          ? "##[error]package_telegram ended with failure"
          : "##[error]package_acceptance_release_checks ended with failure",
    }),
  ).resolves.toBeUndefined();
  await expect(
    validateReleaseWaiverAggregates({
      policy,
      jobs: allJobs,
      getJobLog: () => "##[error]unrelated_integrity ended with failure",
    }),
  ).rejects.toThrow();
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  qualificationRequiredChildJobs,
  validateQualificationChildCompleteness,
} from "../../scripts/release-qualification-coverage.mjs";

const getSource = (path: string) => readFileSync(path, "utf8");
const installJobs = [
  "preflight",
  "root_dockerfile_image",
  "root_dockerfile_image_ready",
  "qr_package_install_smoke",
  "root_dockerfile_smokes",
  "installer_smoke_candidate_payload",
  "installer_smoke_update_image",
  "installer_smoke_nonroot_image",
  "installer_smoke_update",
  "installer_smoke_nonroot",
  "installer_smoke",
  "bun_global_install_smoke",
].map((name) => "install_smoke_release_checks / " + name);
const windowsJobs = [
  "Resolve Windows-node release artifacts",
  "Run Windows-node stable E2E / Setup, connect, and invoke candidate gateway",
];
const qaJobs = [
  "Run QA Live Matrix catalog / Authorize workflow actor",
  "Run QA Live Matrix catalog / Validate selected ref",
  "Run QA Live Matrix catalog / Run Matrix live QA lane",
  "Run QA Lab live Buzz lane / Authorize workflow actor",
  "Run QA Lab live Buzz lane / Validate selected ref",
  "Run QA Lab live Buzz lane / Run Buzz live QA lane with Convex leases",
  "Run QA Lab live Telegram lane",
];
function context(group: string) {
  return {
    role: "releaseChecks",
    inputs: {
      phase: "all",
      rerun_group: group,
      run_release_soak: "true",
      release_profile: "stable",
      mode: "both",
      target_context_ref: "release/2026.11.15",
      candidate_artifact_json: JSON.stringify({ packageVersion: "2099.1.1" }),
      qualification_baselines_json: JSON.stringify({
        upgradeBaseline: "openclaw@2026.9.9",
        upgradeSurvivorBaselines: ["openclaw@2026.9.9"],
      }),
    },
    getSource,
    getCandidateFileNames: () => [
      "legacy-operator-state.mjs",
      "custom-plugin-siblings.mjs",
      "package-activation-recovery.mjs",
    ],
  };
}

describe("frozen qualification completeness", () => {
  it.each([
    ["install-smoke", installJobs],
    ["windows-node", windowsJobs],
    ["qa-live", qaJobs],
  ] as const)("inventories required %s work without advisory gates", (group, expected) => {
    const ctx = context(group);
    expect(qualificationRequiredChildJobs(ctx).toSorted()).toEqual([...expected].toSorted());
    const jobs = expected.map((name) => ({ name, status: "completed", conclusion: "success" }));
    expect(() => validateQualificationChildCompleteness({ ...ctx, jobs })).not.toThrow();
    for (const required of expected) {
      expect(() =>
        validateQualificationChildCompleteness({
          ...ctx,
          jobs: jobs.filter((job) => job.name !== required),
        }),
      ).toThrow(required);
      expect(() =>
        validateQualificationChildCompleteness({
          ...ctx,
          jobs: jobs.map((job) => ({
            name: job.name,
            status: job.status,
            conclusion: job.name === required ? "skipped" : job.conclusion,
          })),
        }),
      ).toThrow(required);
    }
  });

  it("reads frozen Docker shard literals without evaluating candidate code", () => {
    const ctx = context("live-e2e");
    ctx.inputs.phase = "candidate";
    const required = qualificationRequiredChildJobs({
      ...ctx,
      getSource: (path) =>
        path === "scripts/plan-release-workflow-matrix.mjs"
          ? getSource(path) + '\nthrow new Error("candidate code must not execute");\n'
          : getSource(path),
    });
    expect(required).toEqual(
      expect.arrayContaining([
        "Run Docker release-path validation / Docker E2E (core)",
        "Run Docker release-path validation / Docker E2E (plugins/runtime install A)",
        "Run Docker release-path validation / Docker E2E (plugins/runtime install H)",
      ]),
    );
  });

  it("selects same-base beta survivors from candidate capabilities, not Q", () => {
    const ctx = context("package");
    ctx.inputs.run_release_soak = "false";
    ctx.inputs.candidate_artifact_json = JSON.stringify({
      packageVersion: "2026.11.4-beta.1",
      packageSourceSha: "b".repeat(40),
    });
    const required = qualificationRequiredChildJobs({
      ...ctx,
      getSource: (path) => (path === "package.json" ? '{"version":"2026.11.4"}' : getSource(path)),
      getCandidateFileNames: (sha: string) => {
        expect(sha).toBe("b".repeat(40));
        return ["custom-plugin-siblings.mjs"];
      },
    });
    const lanes = required.filter((name) => name.includes("(published-upgrade-survivor"));
    expect(lanes.map((name) => name.slice(name.lastIndexOf("(") + 1, -1))).toEqual([
      "published-upgrade-survivor-2026.9.9-scenarios-1",
      "published-upgrade-survivor-2026.9.9-scenarios-2",
    ]);
  });

  it("retains independent recovery baseline names from the supported Q policy", () => {
    const required = qualificationRequiredChildJobs(context("package"));
    expect(required).toContain(
      "Run package acceptance / Docker product acceptance (artifact-only) / Docker E2E targeted lanes (published-upgrade-survivor-2026.9.8-package-publication-recovery)",
    );
    expect(required).toContain(
      "Run package acceptance / Docker product acceptance (artifact-only) / Docker E2E targeted lanes (published-upgrade-survivor-2026.9.7-package-stranded-first-hop)",
    );
  });

  it.each([
    ["scripts/lib/upgrade-survivor-policy.mjs", '"openclaw@2026.9.8"', '"openclaw@2026.9.6"'],
    ["scripts/lib/upgrade-survivor-policy.mjs", '"2026.6.1"', '"2026.7.1"'],
    [
      "scripts/lib/upgrade-survivor-scenarios.json",
      '"oldestSupportedBaseline": "2026.6.34"',
      '"oldestSupportedBaseline": "2026.7.1"',
    ],
    [
      "scripts/e2e/lib/upgrade-survivor/installed-recovery-cases.mjs",
      '"anchor-before"',
      '"anchor-new"',
    ],
    [
      "scripts/plan-targeted-docker-lane-groups.mjs",
      '"published-upgrade-survivor", "update-migration"',
      '"published-upgrade-survivor"',
    ],
  ])("rejects Q/P planning policy divergence in %s (%s)", (path, before, after) => {
    expect(getSource(path)).toContain(before);
    expect(() =>
      qualificationRequiredChildJobs({
        ...context("package"),
        getSource: (requested) =>
          requested === path ? getSource(requested).replace(before, after) : getSource(requested),
      }),
    ).toThrow("Unsupported frozen qualification Docker policy: " + path);
  });
});

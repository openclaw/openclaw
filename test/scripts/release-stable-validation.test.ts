import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CUT_SHA,
  RELEASE,
  REPOSITORY,
  REPO_ROOT,
  TOOLING_SHA,
  actionRun,
  gitShow,
  legacyCapabilities,
  phaseState,
  postState,
  releaseFixture,
  step,
  type FakeStep,
} from "./release-stable.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const fixture = (state = phaseState("validate")) => {
  const scratch = join(REPO_ROOT, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const release = releaseFixture(directories.make(".release-stable-validation-test-", scratch));
  release.seed(state);
  return release;
};
const toolingTag = "release-publish/bbbbbbbbbbbb-123";
const pnpmCalls = (result: { calls: { bin: string; args: string[] }[] }, command?: string) =>
  result.calls.filter((call) => call.bin === "pnpm" && (!command || call.args[0] === command));
const validationRun = (conclusion = "success", attempt = 1) =>
  actionRun(REPOSITORY, 101, conclusion, attempt);

const validateSetup = (fresh = true): FakeStep[] => [
  ...(fresh ? [step("git", ["rev-parse", "origin/main"], TOOLING_SHA)] : []),
  step("git", ["merge-base", "--is-ancestor", TOOLING_SHA, "origin/main"]),
  ...(fresh
    ? [
        ...[
          ".github/workflows/openclaw-release-publish.yml",
          "scripts/lib/release-publish-children.sh",
          ".github/workflows/openclaw-npm-release.yml",
        ].map((file) => gitShow(`${TOOLING_SHA}:${file}`)),
        step("git", ["tag", "*", TOOLING_SHA]),
        step("git", ["push", "origin", "*"]),
      ]
    : []),
  step("gh", ["api", "*", "--jq", ".object.sha"], TOOLING_SHA),
];

const request = (profile = "stable"): FakeStep =>
  step("pnpm", ["ci:full-release", "--", "--sha", CUT_SHA], "", {
    request: {
      phase: "observed",
      run: { id: 101, attempt: 1 },
      admission: { workflowSha: TOOLING_SHA, workflowRef: toolingTag },
      request: {
        targetSha: CUT_SHA,
        targetContextRef: `release/${RELEASE}`,
        workflowSha: CUT_SHA,
        trustedWorkflowRef: "candidate",
        targetVersion: RELEASE,
        repository: REPOSITORY,
        inputs: { release_profile: profile },
        effectiveSoak: profile === "stable",
      },
    },
  });

it("stops on the first failed stable validation and resumes only after operator recovery", () => {
  const legacy = phaseState("validate");
  const legacyState = {
    ...legacy,
    capabilities: legacyCapabilities(true),
    validate: { ...legacy.validate, continues: 2 },
  };
  const release = fixture(legacyState);
  const failed = release.run([...validateSetup(), request(), validationRun("failure")]);
  expect(failed.status).toBe(2);
  expect(release.readState().validate).not.toHaveProperty("continues");
  expect(release.readState().capabilities).not.toHaveProperty("closeoutResolvesWaivers");
  expect(failed.stderr).toContain(
    "Full Release Validation 101 failed; diagnose before operator recovery.",
  );
  expect(failed.stderr).toContain("pnpm frv status --run 101");
  expect(pnpmCalls(failed, "frv")).toEqual([]);
  const helper = pnpmCalls(failed, "ci:full-release")[0];
  for (const [flag, value] of [
    ["--workflow-sha", CUT_SHA],
    ["--trusted-workflow-ref", "candidate"],
    ["--admission-workflow-sha", TOOLING_SHA],
  ] as const) {
    expect(helper?.args[helper.args.indexOf(flag) + 1]).toBe(value);
  }
  expect(helper?.args).toContain("release_profile=stable");
  expect(helper?.args).toContain("run_release_soak=true");
  const resumed = release.run([
    ...validateSetup(false),
    step("pnpm", ["ci:full-release", "--", "--reconcile-request"], "", { exit: 1 }),
    validationRun("success", 2),
  ]);
  expect(resumed.status, resumed.output).toBe(0);
  expect(release.readState()).toMatchObject({
    validate: { runId: "101", runAttempt: 2 },
    phases: { validate: { status: "completed" } },
  });
  expect(pnpmCalls(resumed, "frv")).toEqual([]);
});

it.each([true, false])(
  "retains historical identity; missing request is refused (present=%s)",
  (present) => {
    const release = fixture();
    const state = phaseState("validate");
    const requestFile = join(release.stateDir, "frv-request.json");
    state.validate = { toolingSha: TOOLING_SHA, toolingTag, requestFile, runId: "101" };
    state.capabilities = postState("validate").capabilities;
    release.seed(state);
    const record = request().request!;
    delete record.admission;
    record.request!.workflowSha = TOOLING_SHA;
    record.request!.trustedWorkflowRef = toolingTag;
    const before = JSON.stringify(record);
    if (present) {
      writeFileSync(requestFile, before);
    }
    const result = release.run([
      ...validateSetup(false),
      ...(present
        ? [
            step("pnpm", ["ci:full-release", "--", "--reconcile-request", requestFile]),
            validationRun(),
          ]
        : []),
    ]);
    if (!present) {
      expect(result.status, result.output).toBe(2);
      expect(result.stderr).toContain("Missing retained Full Release Validation request");
      expect(pnpmCalls(result)).toEqual([]);
      return;
    }
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(requestFile, "utf8")).toBe(before);
    expect(pnpmCalls(result)).toEqual([
      { bin: "pnpm", args: ["ci:full-release", "--", "--reconcile-request", requestFile] },
    ]);
  },
);

it("refuses a retained beta validation before observing or completing it", () => {
  const release = fixture();
  const result = release.run([...validateSetup(), request("beta")]);
  expect(result.status, result.output).toBe(2);
  expect(result.stderr).toContain("strict stable validation selection");
  expect(release.readState().phases.validate.status).not.toBe("completed");
});

it.each([
  ["openclaw.full-release-dispatch/v2", "prepared", "intended", true],
  ["openclaw.full-release-dispatch/v2", "prepared", "uncertain", false],
  ["openclaw.full-release-dispatch/v2", "attempted", "created", false],
  ["openclaw.full-release-dispatch/v1", "prepared", "intended", false],
] as const)(
  "offers canonical resume only before Q mutation (%s/%s/%s)",
  (kind, phase, workflow, resume) => {
    const release = fixture();
    const pending = request();
    pending.request = { ...pending.request!, kind, phase, refs: { workflow }, run: undefined };
    pending.exit = 1;
    const result = release.run([...validateSetup(), pending]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has no observed run");
    expect(result.stderr).toContain("--reconcile-request");
    expect(result.stderr.includes("--resume-request")).toBe(resume);
    expect(pnpmCalls(result)).toHaveLength(1);
    expect(release.readState().validate.runId).toBeUndefined();
  },
);

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CANDIDATE_COMMAND,
  CUT_SHA,
  PHASES,
  PUBLISH_WAIVER,
  RELEASE,
  REPOSITORY,
  REPO_ROOT,
  TOOLING_SHA,
  actionRun,
  gateApproval,
  npmVisibility,
  pendingGates,
  phaseState,
  publishPreparation,
  publishParentRun as parentRun,
  publishChild as child,
  publishState,
  releaseFixture,
  step,
  workflowDispatch,
  type FakeStep,
} from "./release-stable.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const fixture = () => {
  const scratch = join(REPO_ROOT, ".tmp");
  mkdirSync(scratch, { recursive: true });
  return releaseFixture(directories.make(".release-stable-test-", scratch));
};
const fetchMain = () => step("git", ["fetch", "origin", "main:refs/remotes/origin/main"]);
const mainSha = () => step("git", ["rev-parse", "origin/main"], CUT_SHA);

function newCut(packageVersion = RELEASE, missing = ""): FakeStep[] {
  return [
    fetchMain(),
    mainSha(),
    step("git", ["ls-remote", "--heads", "origin", `release/${RELEASE}`]),
    step("git", ["push", "origin", `${CUT_SHA}:refs/heads/release/${RELEASE}`]),
    step("git", ["show", `${CUT_SHA}:package.json`], JSON.stringify({ version: packageVersion })),
    step(
      "git",
      ["show", `${CUT_SHA}:CHANGELOG/${RELEASE}.md`],
      `## ${RELEASE}\n\nRelease notes.\n`,
      { exit: missing === "changelog" ? 1 : 0 },
    ),
    step("git", ["show", `${CUT_SHA}:CHANGELOG/records/${RELEASE}.md`], "Contributor credit.\n", {
      exit: missing === "records" ? 1 : 0,
    }),
  ];
}

function validateSetup(fresh = true): FakeStep[] {
  return [
    ...(fresh ? [step("git", ["rev-parse", "origin/main"], TOOLING_SHA)] : []),
    step("git", ["merge-base", "--is-ancestor", TOOLING_SHA, "origin/main"]),
    ...(fresh
      ? [
          step("git", ["show", `${TOOLING_SHA}:.github/workflows/openclaw-release-publish.yml`]),
          step("git", ["show", "origin/main:.github/workflows/openclaw-stable-main-closeout.yml"]),
          step("git", ["show", `${TOOLING_SHA}:scripts/lib/release-publish-children.sh`]),
          step("git", ["tag", "*", TOOLING_SHA]),
          step("git", ["push", "origin", "*"]),
        ]
      : []),
    step("gh", ["api", "*", "--jq", ".object.sha"], TOOLING_SHA),
  ];
}

function request(attempt = 1): FakeStep {
  return step("pnpm", ["ci:full-release", "--", "--sha", CUT_SHA], "", {
    request: { phase: "observed", run: { id: 101, attempt } },
  });
}

function validationRun(conclusion: string, attempt: number): FakeStep {
  return step(
    "gh",
    ["api", `repos/${REPOSITORY}/actions/runs/101`],
    JSON.stringify({ status: "completed", conclusion, run_attempt: attempt }),
  );
}

const publishWorkflow = "openclaw-release-publish.yml";
const toolingTag = "release-publish/bbbbbbbbbbbb-123";
const parentDispatch = () =>
  step("gh", ["workflow", "run", publishWorkflow, "--repo", REPOSITORY, "--ref", toolingTag]);
const parentRuns = (runs: object[]) =>
  step(
    "gh",
    [
      "api",
      `repos/${REPOSITORY}/actions/workflows/${publishWorkflow}/runs?event=workflow_dispatch&per_page=10`,
    ],
    JSON.stringify({ workflow_runs: runs }),
  );
const children = (runs: object[]) =>
  step("gh", ["api", "*"], JSON.stringify({ workflow_runs: runs }));

describe("release:stable CLI", () => {
  it("previews all seven phases without executing a binary or writing release state", () => {
    const release = fixture();
    const result = release.run([], ["--dry-run"]);
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([]);
    expect(existsSync(release.stateDir)).toBe(false);
    for (const phase of PHASES) {
      expect(result.stdout).toContain(`[release-stable] ${phase}: completed`);
    }
    for (const command of [
      `git push origin refs/tags/v${RELEASE}`,
      "gh workflow run openclaw-release-publish.yml",
      "gh workflow run openclaw-npm-dist-tags.yml",
      `gh release edit v${RELEASE}`,
      "gh workflow run openclaw-macos-publish.yml",
      `gh release view v${RELEASE} --repo ${REPOSITORY} --json assets --jq '[.assets[].name]'`,
    ]) {
      expect(result.stdout).toContain(`+ ${command}`);
    }
    expect(result.stdout.match(/Would ask:/gu)).toHaveLength(2);
    expect(result.stdout).toContain("preflight_only=true");
    expect(result.stdout).toContain("preflight_only=false");
  });

  it("refuses a noninteractive cut before creating its branch and prints exact confirmation", () => {
    const release = fixture();
    const result = release.run([fetchMain(), mainSha()]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refused: Non-interactive confirmation required:");
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from cut`);
    expect(result.stderr).toContain(`--confirm-cut-sha ${CUT_SHA}`);
    expect(release.readState().operator.cutShaConfirmed).toBeNull();
    expect(release.readState().phases.cut.status).toBe("refused");
  });

  it.each([
    {
      label: "wrong-version",
      packageVersion: "2026.9.5",
      missing: "",
      code: 2,
      phaseStatus: "refused",
    },
    {
      label: "missing-changelog",
      packageVersion: RELEASE,
      missing: "changelog",
      code: 2,
      phaseStatus: "refused",
    },
    {
      label: "missing-records",
      packageVersion: RELEASE,
      missing: "records",
      code: 2,
      phaseStatus: "refused",
    },
    { label: "prepared", packageVersion: RELEASE, missing: "", code: 0, phaseStatus: "completed" },
  ])(
    "creates the confirmed branch and checks an $label cut",
    ({ packageVersion, missing, code, phaseStatus }) => {
      const release = fixture();
      const state = phaseState("cut");
      state.cut = {};
      state.operator.cutShaConfirmed = null;
      release.seed(state);
      const result = release.run(newCut(packageVersion, missing), ["--confirm-cut-sha", CUT_SHA]);
      expect(result.status, result.output).toBe(code);
      const retained = release.readState();
      expect(retained.phases.cut.status).toBe(phaseStatus);
      expect(retained.operator.cutShaConfirmed).toBe(CUT_SHA);
      expect(result.calls.filter((call) => call.bin === "git" && call.args[0] === "push")).toEqual([
        { bin: "git", args: ["push", "origin", `${CUT_SHA}:refs/heads/release/${RELEASE}`] },
      ]);
      if (code === 2) {
        expect(result.stderr).toContain(`pnpm release:prepare -- --version ${RELEASE} --write`);
        expect(result.stderr).toContain("pnpm changelog:check");
        expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from cut`);
        expect(retained.cut.releaseSha).toBeUndefined();
      } else {
        expect(retained.cut.releaseSha).toBe(CUT_SHA);
      }
    },
  );

  it("keeps the confirmed cut when a remote branch has advanced to a prepared descendant", () => {
    const release = fixture();
    const state = phaseState("cut");
    release.seed(state);
    const tip = "c".repeat(40);
    const result = release.run([
      fetchMain(),
      mainSha(),
      step(
        "git",
        ["ls-remote", "--heads", "origin", `release/${RELEASE}`],
        `${tip}\trefs/heads/release/${RELEASE}\n`,
      ),
      step("git", ["fetch", "origin", `release/${RELEASE}`]),
      step("git", ["rev-parse", "FETCH_HEAD"], tip),
      step("git", ["merge-base", "--is-ancestor", CUT_SHA, tip]),
      step("git", ["show", `${tip}:package.json`], JSON.stringify({ version: RELEASE })),
      step("git", ["show", `${tip}:CHANGELOG/${RELEASE}.md`], `## ${RELEASE}\n`),
      step("git", ["show", `${tip}:CHANGELOG/records/${RELEASE}.md`]),
    ]);
    expect(result.status, result.output).toBe(0);
    expect(release.readState().cut).toEqual({ cutSha: CUT_SHA, releaseSha: tip });
    expect(result.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(result.stdout).not.toContain("Confirm cut SHA");
  });

  it("continues failed validation only twice, then resumes with its pinned tooling and observed run", () => {
    const release = fixture();
    release.seed(phaseState("validate"));
    const failed = release.run([
      ...validateSetup(),
      request(),
      validationRun("failure", 1),
      step("pnpm", ["frv", "continue", "--failed", "--run", "101"]),
      validationRun("failure", 2),
      step("pnpm", ["frv", "continue", "--failed", "--run", "101"]),
      validationRun("failure", 3),
    ]);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("Full Release Validation 101 failed after two continues.");
    expect(failed.stderr).toContain("pnpm frv status --run 101");
    expect(release.readState().validate.continues).toBe(2);
    const createdToolingTag = release.readState().validate.toolingTag;
    expect(createdToolingTag).toMatch(/^release-publish\/bbbbbbbbbbbb-\d+$/u);
    const resumed = release.run([
      ...validateSetup(false),
      step("pnpm", ["ci:full-release", "--", "--sha", CUT_SHA], "", { exit: 1 }),
      validationRun("success", 4),
      step("npm", ["view", "openclaw", "dist-tags.latest"], "2026.9.5\n"),
    ]);
    expect(resumed.status, resumed.output).toBe(0);
    expect(
      resumed.calls.filter((call) => call.bin === "git" && call.args[0] === "tag"),
    ).toHaveLength(1);
    expect(
      resumed.calls.filter((call) => call.bin === "pnpm" && call.args[0] === "frv"),
    ).toHaveLength(2);
    const retained = release.readState();
    expect(retained.validate).toMatchObject({
      toolingSha: TOOLING_SHA,
      toolingTag: createdToolingTag,
      runId: "101",
      runAttempt: 4,
      continues: 2,
      laneWaiver: "",
      stableSoakWaiver: `Operator-approved by release-test for ${RELEASE}: beta-profile Full Release Validation 101 attempt 4 green; soak, live/E2E, Telegram, QA-live, and Parallels deferred to postpublish confidence; update from 2026.9.5 to the candidate proven.`,
    });
    expect(retained.phases.validate.status).toBe("completed");
    const helperCalls = resumed.calls.filter(
      (call) => call.bin === "pnpm" && call.args[0] === "ci:full-release",
    );
    expect(helperCalls).toHaveLength(2);
    expect(helperCalls[0]?.args).toEqual(helperCalls[1]?.args);
    expect(helperCalls[0]?.args).not.toContain("reuse_evidence");
  });

  it("refuses an unobserved FRV request with the helper's reconciliation command", () => {
    const release = fixture();
    release.seed(phaseState("validate"));
    const result = release.run([
      ...validateSetup(),
      step("pnpm", ["ci:full-release"], "", { request: { phase: "dispatching" }, exit: 1 }),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has no observed run");
    expect(result.stderr).toContain(
      `pnpm ci:full-release -- --reconcile-request ${join(release.stateDir, "frv-request.json")}`,
    );
    expect(release.readState().validate.runId).toBeUndefined();
  });

  it("prints retained status without changing state or invoking release helpers", () => {
    const release = fixture();
    const state = phaseState("macos");
    state.macos = { validateRunId: "201", preflightRunId: "202" };
    release.seed(state);
    const before = readFileSync(release.stateFile, "utf8");
    const result = release.run([], ["--status"]);
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toMatch(/cut\s+completed\s+cutSha=/u);
    expect(result.stdout).toMatch(/macos\s+pending\s+validateRunId=201 preflightRunId=202/u);
    expect(result.stdout.trim().split("\n")).toHaveLength(7);
    expect(readFileSync(release.stateFile, "utf8")).toBe(before);
  });

  it("refuses unknown retained state fields without overwriting the recovery evidence", () => {
    const release = fixture();
    const state = phaseState("validate");
    release.seed(state);
    const invalid = JSON.stringify({ ...state, validate: { ...state.validate, unknown: true } });
    writeFileSync(release.stateFile, invalid);
    const result = release.run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid state file");
    expect(result.stderr).toContain("Move the file aside before retrying.");
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE}`);
    expect(readFileSync(release.stateFile, "utf8")).toBe(invalid);
  });

  it("refuses a live process lock before touching state and replaces a stale lock", () => {
    const release = fixture();
    release.seed(phaseState("cut"));
    const before = readFileSync(release.stateFile, "utf8");
    const lock = join(release.stateDir, "state.lock");
    const live = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    writeFileSync(lock, live);
    const refused = release.run([]);
    expect(refused.status, refused.output).toBe(2);
    expect(refused.stderr).toContain(
      `Another release:stable process (pid ${process.pid}) owns ${release.stateDir}`,
    );
    expect(refused.stderr).toContain(`# wait for it or remove ${lock} if that pid is gone`);
    expect(refused.stderr).toContain(`pnpm release:stable ${RELEASE}`);
    expect(readFileSync(release.stateFile, "utf8")).toBe(before);
    expect(readFileSync(lock, "utf8")).toBe(live);
    expect(refused.calls).toEqual([]);
    expect(release.run([], ["--status"]).status).toBe(0);
    expect(release.run([], ["--dry-run"]).status).toBe(0);
    expect(readFileSync(lock, "utf8")).toBe(live);
    expect(() => process.kill(999999, 0)).toThrow();
    writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: "2000-01-01T00:00:00.000Z" }));
    const cutSteps = newCut();
    cutSteps[0] = { ...fetchMain(), verifyLock: true };
    const resumed = release.run(cutSteps);
    expect(resumed.status, resumed.output).toBe(0);
    expect(release.readState().phases.cut.status).toBe("completed");
    expect(existsSync(lock)).toBe(false);
  });

  it("prepares the final tag and macOS lanes but refuses publication without operator approval", () => {
    const release = fixture();
    const state = publishState();
    state.operator.publicationApproved = null;
    delete state.operator.login;
    delete state.publish.macosValidateRunId;
    delete state.publish.macosPreflightRunId;
    release.seed(state);
    release.candidate(CANDIDATE_COMMAND);
    const result = release.run([
      ...publishPreparation(true),
      step("gh", ["api", "user", "--jq", ".login"], "release-test\n"),
      ...workflowDispatch("openclaw-macos-validate.yml", "openclaw/releases", 201),
      ...workflowDispatch("openclaw-macos-publish.yml", "openclaw/releases", 202),
    ]);
    expect(result.status, result.output).toBe(2);
    expect(result.stderr).toContain(`Approve publication of v${RELEASE}? [y/N]`);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      `pnpm release:stable ${RELEASE} --from publish --state-dir ${release.stateDir} --operator release-test --approve-publication`,
    );
    expect(result.stdout).toContain(`stable_soak_waiver=${PUBLISH_WAIVER}`);
    expect(result.stdout).toContain("FRV=101 attempt 3");
    expect(result.stdout).toContain(`release SHA=${CUT_SHA}`);
    expect(result.stdout).toContain(`tooling tag=${toolingTag}`);
    expect(result.stdout).toContain("lane_waiver=Deferred fixture lanes");
    const retained = release.readState();
    expect(retained.operator.login).toBe("release-test");
    expect(result.calls.filter((call) => call.args[1] === "user")).toHaveLength(1);
    expect(retained.operator.publicationApproved).toBeNull();
    expect(retained.phases.publish.status).toBe("refused");
    expect(retained.publish).toMatchObject({
      macosValidateRunId: "201",
      macosPreflightRunId: "202",
    });
    expect(retained.publish.publishRunId).toBeUndefined();
    const preflight = result.calls.find((call) => call.args[2] === "openclaw-macos-publish.yml");
    expect(preflight?.args.slice(7)).toEqual([
      "-f",
      `tag=v${RELEASE}`,
      "-f",
      `source_ref=release/${RELEASE}`,
      "-f",
      `public_release_branch=release/${RELEASE}`,
      "-f",
      "preflight_only=true",
      "-f",
      "smoke_test_only=false",
      "-f",
      "allow_late_calver_recovery=false",
    ]);
  });

  it("prints child approval guidance, approves only parent gates, and resumes without redispatch", () => {
    const release = fixture();
    const state = publishState();
    state.operator.publicationApproved = null;
    if (state.capabilities) {
      state.capabilities.parentSyncsBetaDistTag = true;
    }
    release.seed(state);
    release.candidate(CANDIDATE_COMMAND);
    const ignored = [
      { ...child(610), head_branch: "release-publish/cccccccccccc-456" },
      { ...child(611), actor: { login: "human" } },
      { ...child(612), event: "push" },
      child(613, "Unrelated workflow", "unrelated.yml"),
      { ...child(614), created_at: "2000-01-01T00:00:00.000Z" },
      { ...child(615), status: "completed" },
    ];
    const parentGates = [
      { id: 71, name: "npm-release" },
      { id: 72, name: "clawhub-plugin-release" },
      { id: 73, name: "npm-release" },
      { id: 74, name: "mac-release" },
    ];
    const childGates = [
      { id: 81, name: "npm-release" },
      { id: 82, name: "clawhub-plugin-release" },
      { id: 81, name: "npm-release" },
    ];
    const liveChildren = [
      child(701),
      child(702, "Plugin ClawHub Release", "plugin-clawhub-release.yml"),
      child(703, "OpenClaw NPM Release", "openclaw-npm-release.yml"),
      ...ignored,
    ];
    const failed = release.run(
      [
        ...publishPreparation(),
        parentDispatch(),
        parentRuns([parentRun()]),
        pendingGates(301, parentGates),
        gateApproval(301, 71),
        gateApproval(301, 73),
        children(liveChildren),
        pendingGates(701, childGates),
        pendingGates(703, [{ id: 83, name: "npm-release" }]),
        npmVisibility(false),
        step(
          "gh",
          ["api", `repos/${REPOSITORY}/actions/runs/301`],
          JSON.stringify({ status: "in_progress", conclusion: null, run_attempt: 3 }),
        ),
        pendingGates(301, parentGates),
        children(liveChildren),
        npmVisibility(false),
        actionRun(REPOSITORY, 301, "failure", 3),
      ],
      ["--approve-publication"],
    );
    expect(failed.status, failed.output).toBe(2);
    expect(failed.stderr).toContain("Publish parent 301 failure before core npm became visible.");
    expect(failed.stderr).toContain(
      `pnpm release:publish-preflight --tag v${RELEASE} --full-release-validation-run-id 101 --full-release-validation-run-attempt 3 --npm-dist-tag latest --workflow-ref ${toolingTag}`,
    );
    expect(failed.stderr).toContain(`pnpm release:stable ${RELEASE} --from publish`);
    for (const output of [failed.stdout, failed.stderr]) {
      expect(output).toContain("status=waiting&per_page=100");
      expect(output).toContain("status=queued&per_page=100");
      expect(output).toContain("state=rejected");
      expect(output).toContain("gh run cancel '<child>'");
    }
    for (const id of [701, 703]) {
      expect(failed.stdout.match(new RegExp(`publish: child ${id} `, "gu"))).toHaveLength(1);
    }
    expect(failed.stdout).toContain("approve only if it belongs to parent 301:");
    expect(failed.stdout).toContain("'environment_ids[]=81'");
    for (const run of ignored) {
      expect(failed.stdout).not.toContain(`child ${run.id} `);
    }
    const refused = release.readState();
    expect(refused.operator.publicationApproved).toEqual(expect.any(String));
    expect(refused.publish.npmVisibleAt).toBeUndefined();
    expect(refused.publish.approvedGates).toEqual(["301:71", "301:73"]);
    expect(refused.phases.publish.status).toBe("refused");
    const resumed = release.run([
      ...publishPreparation(),
      pendingGates(301, parentGates),
      children(liveChildren),
      pendingGates(701, childGates),
      pendingGates(703, [{ id: 83, name: "npm-release" }]),
      npmVisibility(),
    ]);
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.stdout).not.toContain("Approve publication");
    const dispatches = resumed.calls.filter((call) => call.args[0] === "workflow");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.args.slice(7)).toEqual([
      "-f",
      `tag=v${RELEASE}`,
      "-f",
      "full_release_validation_run_id=101",
      "-f",
      "full_release_validation_run_attempt=3",
      "-f",
      "npm_dist_tag=latest",
      "-f",
      "plugin_publish_scope=all-publishable",
      "-f",
      `stable_soak_waiver=${PUBLISH_WAIVER}`,
      "-f",
      "lane_waiver=Deferred fixture lanes",
      "-f",
      "publish_openclaw_npm=true",
      "-f",
      "wait_for_clawhub=false",
    ]);
    const helper = resumed.calls.find((call) => call.bin === "pnpm");
    expect(helper?.args).toContain(PUBLISH_WAIVER);
    expect(helper?.args).toContain("--skip-dispatch");
    expect(helper?.args).toContain("--skip-parallels");
    expect(helper?.args).toContain("--skip-telegram");
    expect(resumed.calls.filter((call) => call.args.includes("POST"))).toEqual([
      { bin: "gh", args: gateApproval(301, 71).match },
      { bin: "gh", args: gateApproval(301, 73).match },
    ]);
    const childReads = resumed.calls.filter((call) =>
      call.args[1]?.includes("?status=waiting&event=workflow_dispatch&per_page=100"),
    );
    expect(childReads).toHaveLength(3);
    expect(
      childReads.every((call) =>
        call.args[1]?.endsWith(`created=>=${refused.publish.dispatchedAt}`),
      ),
    ).toBe(true);
    expect(release.readState().publish).toMatchObject({
      publishRunId: "301",
      npmVisibleAt: expect.any(String),
      approvedGates: ["301:71", "301:73"],
    });
    expect(release.readState().phases.publish.status).toBe("completed");
  });

  it("uses the parent's approval receipt without reading or approving any child gates", () => {
    const release = fixture();
    const state = publishState(true);
    state.publish.publishRunId = "301";
    state.publish.dispatchedAt = state.startedAt;
    release.seed(state);
    release.candidate(CANDIDATE_COMMAND);
    const result = release.run([
      ...publishPreparation(),
      pendingGates(301, [
        { id: 71, name: "npm-release" },
        { id: 72, name: "clawhub-plugin-release" },
      ]),
      gateApproval(301, 71),
      npmVisibility(),
    ]);
    expect(result.status, result.output).toBe(0);
    expect(release.readState().publish.approvedGates).toEqual(["301:71"]);
    expect(release.readState().publish.npmVisibleAt).toEqual(expect.any(String));
    expect(release.readState().phases.publish.status).toBe("completed");
    expect(result.calls.filter((call) => call.bin === "gh")).toHaveLength(2);
  });

  it("reconciles an uncertain dispatch only for the recorded actor without repeating the mutation", () => {
    const release = fixture();
    const state = publishState(true);
    delete state.operator.login;
    if (state.capabilities) {
      delete state.capabilities.parentSweepsStaleChildren;
    }
    release.seed(state);
    release.candidate(CANDIDATE_COMMAND);
    const distractors = [
      { ...parentRun(), id: 801, head_branch: "main" },
      { ...parentRun(), id: 802, display_title: "Publish v2026.9.5" },
      { ...parentRun(), id: 803, created_at: "2000-01-01T00:00:00.000Z" },
      { ...parentRun(), id: 804, actor: { login: "another-operator" } },
      { ...parentRun(), id: 805, event: "push" },
      { ...parentRun(), id: 806, path: ".github/workflows/unrelated.yml" },
      { ...parentRun(), id: 807, created_at: "2099-01-01T00:00:00.000Z" },
    ];
    const failed = release.run([
      ...publishPreparation(),
      step(
        "git",
        ["show", `${TOOLING_SHA}:.github/workflows/openclaw-release-publish.yml`],
        "release-approval-receipt",
      ),
      step("git", ["show", "origin/main:.github/workflows/openclaw-stable-main-closeout.yml"]),
      step(
        "git",
        ["show", `${TOOLING_SHA}:scripts/lib/release-publish-children.sh`],
        "sweep_superseded_children",
      ),
      step("gh", ["api", "user", "--jq", ".login"], "release-test\n"),
      { ...parentDispatch(), exit: 1, stderr: "connection lost after submission" },
      { ...parentRuns(distractors), times: 10 },
    ]);
    expect(failed.status, failed.output).toBe(2);
    expect(failed.stdout).not.toContain("state=rejected");
    expect(release.readState().capabilities?.parentSweepsStaleChildren).toBe(true);
    expect(failed.stderr).toContain(
      `Could not reconcile ${publishWorkflow}; the dispatch may have been accepted.`,
    );
    expect(failed.stderr).toContain(
      `gh run list --repo ${REPOSITORY} --workflow ${publishWorkflow}`,
    );
    const intent = release
      .readState()
      .history.find((entry) => entry.event === `dispatch-intent:${publishWorkflow}`);
    expect(intent?.at).toEqual(expect.any(String));
    expect(release.readState().publish.publishRunId).toBeUndefined();
    const resumed = release.run([
      ...publishPreparation(),
      parentRuns([...distractors, parentRun()]),
      pendingGates(301),
      npmVisibility(),
    ]);
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.calls.filter((call) => call.args[0] === "workflow")).toHaveLength(1);
    expect(resumed.calls.filter((call) => call.args[1] === "user")).toHaveLength(1);
    expect(resumed.calls.filter((call) => call.args[1]?.includes("?status="))).toHaveLength(0);
    expect(release.readState().publish).toMatchObject({
      publishRunId: "301",
      dispatchedAt: intent?.at,
    });
    expect(
      release
        .readState()
        .history.filter((entry) => entry.event === `dispatch-intent:${publishWorkflow}`),
    ).toHaveLength(1);
  });

  it("refuses ambiguous main-ref dispatches instead of choosing the newest run", () => {
    const release = fixture();
    const state = publishState(true);
    state.operator.publicationApproved = null;
    delete state.publish.macosValidateRunId;
    release.seed(state);
    release.candidate(CANDIDATE_COMMAND);
    const workflow = "openclaw-macos-validate.yml";
    const result = release.run([
      ...publishPreparation(),
      step("gh", ["workflow", "run", workflow]),
      step(
        "gh",
        [
          "api",
          `repos/openclaw/releases/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`,
        ],
        JSON.stringify({
          workflow_runs: [201, 211].map((id) => ({
            id,
            event: "workflow_dispatch",
            actor: { login: "release-test" },
            created_at: new Date().toISOString(),
            path: `.github/workflows/${workflow}`,
            head_branch: "main",
            display_title: "macOS Validate",
          })),
        }),
      ),
    ]);
    expect(result.status, result.output).toBe(2);
    expect(result.stderr).toContain(`Ambiguous dispatch of ${workflow}: runs 201, 211`);
    expect(result.stderr).toContain(`gh run list --repo openclaw/releases --workflow ${workflow}`);
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from publish`);
    expect(release.readState().publish.macosValidateRunId).toBeUndefined();
  });

  it.each([false, true])(
    "bounds gh GET retries and never retries an approval mutation (exhausted=%s)",
    (exhausted) => {
      const release = fixture();
      const state = publishState(true);
      state.publish.publishRunId = "301";
      release.seed(state);
      release.candidate(CANDIDATE_COMMAND);
      const result = release.run([
        ...publishPreparation(),
        {
          ...pendingGates(301),
          exit: 1,
          stderr: "temporary API failure",
          times: exhausted ? 4 : 3,
        },
        ...(exhausted
          ? []
          : [
              pendingGates(301, [{ id: 71, name: "npm-release" }]),
              { ...gateApproval(301, 71), exit: 1, stderr: "approval connection lost" },
            ]),
      ]);
      expect(result.status, result.output).toBe(2);
      expect(result.stderr).toContain(
        exhausted ? "temporary API failure" : "approval connection lost",
      );
      const reads = result.calls.filter(
        (call) => call.bin === "gh" && call.args[1]?.endsWith("pending_deployments"),
      );
      expect(reads).toHaveLength(4);
      expect(result.calls.filter((call) => call.args.includes("POST"))).toHaveLength(
        exhausted ? 0 : 1,
      );
      expect(release.readState().publish.approvedGates).toEqual([]);
      expect(release.readState().publish.npmVisibleAt).toBeUndefined();
    },
  );
});

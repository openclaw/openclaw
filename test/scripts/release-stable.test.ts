import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CANDIDATE_COMMAND,
  CUT_SHA,
  legacyCapabilities,
  PHASES,
  RELEASE,
  REPOSITORY,
  REPO_ROOT,
  TOOLING_SHA,
  actionRun,
  dispatchWorkflow,
  fetchMain,
  fields,
  gateApproval,
  gitShow,
  jsonStep,
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
  workflowRun,
  workflowRuns,
  type FakeStep,
} from "./release-stable.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const fixture = (state?: ReturnType<typeof phaseState>) => {
  const scratch = join(REPO_ROOT, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const release = releaseFixture(directories.make(".release-stable-test-", scratch));
  if (state) {
    release.seed(state);
  }
  return release;
};
const publishing = (state = publishState()) => {
  const release = fixture(state);
  release.candidate(CANDIDATE_COMMAND);
  return release;
};
const mainSha = () => step("git", ["rev-parse", "origin/main"], CUT_SHA);

function newCut(packageVersion = RELEASE, missing = ""): FakeStep[] {
  return [
    fetchMain(),
    mainSha(),
    step("git", ["ls-remote", "--heads", "origin", `release/${RELEASE}`]),
    step("pnpm", ["release:push", "--", "--head", CUT_SHA, "--branch", `release/${RELEASE}`]),
    gitShow(`${CUT_SHA}:package.json`, JSON.stringify({ version: packageVersion })),
    gitShow(
      `${CUT_SHA}:CHANGELOG/${RELEASE}.md`,
      `## ${RELEASE}\n\nRelease notes.\n`,
      missing === "changelog" ? 1 : 0,
    ),
    gitShow(
      `${CUT_SHA}:CHANGELOG/records/${RELEASE}.md`,
      "Contributor credit.\n",
      missing === "records" ? 1 : 0,
    ),
  ];
}

const publishWorkflow = "openclaw-release-publish.yml";
const toolingTag = "release-publish/bbbbbbbbbbbb-123";
const parentDispatch = () => dispatchWorkflow(publishWorkflow, REPOSITORY, toolingTag);
const parentRuns = (runs: object[]) => workflowRuns(publishWorkflow, REPOSITORY, runs);
const children = (runs: object[]) => jsonStep("gh", ["api", "*"], { workflow_runs: runs });

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
    expect(release.readState()).toMatchObject({
      operator: { cutShaConfirmed: null },
      phases: { cut: { status: "refused" } },
    });
  });

  it.each([
    ["wrong-version", "2026.9.5", "", 2, "refused"],
    ["missing-changelog", RELEASE, "changelog", 2, "refused"],
    ["missing-records", RELEASE, "records", 2, "refused"],
    ["prepared", RELEASE, "", 0, "completed"],
  ] as const)("validates the %s cut", (_label, packageVersion, missing, code, phaseStatus) => {
    const state = phaseState("cut");
    state.cut = {};
    state.operator.cutShaConfirmed = null;
    const release = fixture(state);
    const result = release.run(newCut(packageVersion, missing), ["--confirm-cut-sha", CUT_SHA]);
    expect(result.status, result.output).toBe(code);
    const retained = release.readState();
    expect(retained).toMatchObject({
      phases: { cut: { status: phaseStatus } },
      operator: { cutShaConfirmed: CUT_SHA },
    });
    expect(
      result.calls.filter((call) => call.bin === "pnpm" && call.args[0] === "release:push"),
    ).toEqual([
      {
        bin: "pnpm",
        args: ["release:push", "--", "--head", CUT_SHA, "--branch", `release/${RELEASE}`],
      },
    ]);
    if (code === 2) {
      expect(result.stderr).toContain(`pnpm release:prepare -- --version ${RELEASE} --write`);
      expect(result.stderr).toContain("pnpm changelog:check");
      expect(result.stderr).toContain("pnpm release:push");
      expect(result.stderr).not.toContain(`git push origin release/${RELEASE}`);
      expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from cut`);
      expect(retained.cut.releaseSha).toBeUndefined();
    } else {
      expect(retained.cut.releaseSha).toBe(CUT_SHA);
    }
  });

  it("keeps the confirmed cut when a remote branch has advanced to a prepared descendant", () => {
    const release = fixture(phaseState("cut"));
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
      gitShow(`${tip}:package.json`, JSON.stringify({ version: RELEASE })),
      gitShow(`${tip}:CHANGELOG/${RELEASE}.md`, `## ${RELEASE}\n`),
      gitShow(`${tip}:CHANGELOG/records/${RELEASE}.md`),
    ]);
    expect(result.status, result.output).toBe(0);
    expect(release.readState().cut).toEqual({ cutSha: CUT_SHA, releaseSha: tip });
    expect(result.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(result.stdout).not.toContain("Confirm cut SHA");
  });

  it.each([0, 2])("reads legacy status without mutation (counter=%i)", (continues) => {
    const state = phaseState("macos");
    state.macos = { validateRunId: "201", preflightRunId: "202" };
    const legacyState = {
      ...state,
      capabilities: legacyCapabilities(continues > 0),
      validate: { ...state.validate, continues },
    };
    const release = fixture(legacyState);
    const before = readFileSync(release.stateFile, "utf8");
    const result = release.run([], ["--status"]);
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toMatch(/cut\s+completed\s+cutSha=/u);
    expect(result.stdout).toMatch(/macos\s+pending\s+validateRunId=201 preflightRunId=202/u);
    expect(result.stdout.trim().split("\n")).toHaveLength(7);
    expect(readFileSync(release.stateFile, "utf8")).toBe(before);
  });

  it.each(["stableSoakWaiver", "laneWaiver"])("preserves rejected %s state", (field) => {
    const state = phaseState("validate");
    const release = fixture(state);
    const invalid = JSON.stringify({
      ...state,
      capabilities: legacyCapabilities(true),
      validate: { ...state.validate, continues: 2, [field]: "retained legacy value" },
    });
    writeFileSync(release.stateFile, invalid);
    const result = release.run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid state file");
    expect(result.stderr).toContain("Move the file aside before retrying.");
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE}`);
    expect(readFileSync(release.stateFile, "utf8")).toBe(invalid);
  });

  it("refuses a live process lock before touching state and replaces a stale lock", () => {
    const release = fixture(phaseState("cut"));
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
    const state = publishState();
    state.operator.publicationApproved = null;
    delete state.operator.login;
    delete state.publish.macosValidateRunId;
    delete state.publish.macosPreflightRunId;
    const release = publishing(state);
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
    expect(result.stdout).not.toContain("stable_soak_waiver");
    expect(result.stdout).toContain("FRV=101 attempt 3");
    expect(result.stdout).toContain(`release SHA=${CUT_SHA}`);
    expect(result.stdout).toContain(`tooling tag=${toolingTag}`);
    expect(result.stdout).not.toContain("lane_waiver");
    const retained = release.readState();
    expect(result.calls.filter((call) => call.args[1] === "user")).toHaveLength(1);
    expect(retained).toMatchObject({
      operator: { login: "release-test", publicationApproved: null },
      phases: { publish: { status: "refused" } },
      publish: { macosValidateRunId: "201", macosPreflightRunId: "202" },
    });
    expect(retained.publish.publishRunId).toBeUndefined();
    const preflight = result.calls.find((call) => call.args[2] === "openclaw-macos-publish.yml");
    expect(preflight?.args.slice(7)).toEqual(
      fields(
        `tag=v${RELEASE}`,
        `source_ref=release/${RELEASE}`,
        `public_release_branch=release/${RELEASE}`,
        "preflight_only=true",
        "smoke_test_only=false",
        "allow_late_calver_recovery=false",
      ),
    );
  });

  it.each([false, true])("requires a signed local final tag (resigned=%s)", (resigned) => {
    const state = publishState();
    state.operator.publicationApproved = null;
    const release = publishing(state);
    const result = release.run([
      step("pnpm", ["release:candidate", "--", "--tag", `v${RELEASE}`]),
      step("git", ["ls-remote", "--tags", "origin", `v${RELEASE}`, `v${RELEASE}^{}`]),
      step("git", ["tag", "-s", `v${RELEASE}`, CUT_SHA, "-m", `OpenClaw ${RELEASE}`], "", {
        exit: 1,
      }),
      step("git", ["rev-parse", `v${RELEASE}^{}`], CUT_SHA),
      step("git", ["tag", "-s", "-f", `v${RELEASE}`, CUT_SHA, "-m", `OpenClaw ${RELEASE}`], "", {
        exit: resigned ? 0 : 1,
      }),
      ...(resigned ? [step("git", ["push", "origin", `refs/tags/v${RELEASE}`])] : []),
    ]);
    if (resigned) {
      expect(result.stderr).not.toContain(`Could not create signed final tag v${RELEASE}`);
      expect(result.calls).toContainEqual({
        bin: "git",
        args: ["push", "origin", `refs/tags/v${RELEASE}`],
      });
    } else {
      expect(result.status, result.output).toBe(2);
      expect(result.stderr).toContain(`Could not create signed final tag v${RELEASE}`);
      expect(result.calls.some((call) => call.bin === "git" && call.args[0] === "push")).toBe(
        false,
      );
    }
  });

  it("prints child approval guidance, approves only parent gates, and resumes without redispatch", () => {
    const state = publishState();
    state.operator.publicationApproved = null;
    if (state.capabilities) {
      state.capabilities.parentSyncsBetaDistTag = true;
    }
    const release = publishing(state);
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
    const childGateReads = () => [
      children(liveChildren),
      pendingGates(701, childGates),
      pendingGates(703, [{ id: 83, name: "npm-release" }]),
    ];
    const failed = release.run(
      [
        ...publishPreparation(),
        parentDispatch(),
        parentRuns([parentRun()]),
        pendingGates(301, parentGates),
        gateApproval(301, 71),
        gateApproval(301, 73),
        ...childGateReads(),
        npmVisibility(false),
        jsonStep("gh", ["api", `repos/${REPOSITORY}/actions/runs/301`], {
          status: "in_progress",
          conclusion: null,
          run_attempt: 3,
        }),
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
    expect(refused.publish.npmVisibleAt).toBeUndefined();
    expect(refused).toMatchObject({
      operator: { publicationApproved: expect.any(String) },
      publish: { approvedGates: ["301:71", "301:73"] },
      phases: { publish: { status: "refused" } },
    });
    const resumed = release.run([
      ...publishPreparation(),
      pendingGates(301, parentGates),
      ...childGateReads(),
      npmVisibility(),
    ]);
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.stdout).not.toContain("Approve publication");
    const dispatches = resumed.calls.filter((call) => call.args[0] === "workflow");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.args.slice(7)).toEqual(
      fields(
        `tag=v${RELEASE}`,
        "full_release_validation_run_id=101",
        "full_release_validation_run_attempt=3",
        "npm_dist_tag=latest",
        "plugin_publish_scope=all-publishable",
        "publish_openclaw_npm=true",
        "wait_for_clawhub=false",
      ),
    );
    const helper = resumed.calls.find((call) => call.bin === "pnpm");
    expect(helper?.args).toContain("stable");
    expect(helper?.args).not.toContain("--stable-soak-waiver");
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

  it("uses npm-publish tooling without reading or approving any child gates", () => {
    const state = publishState(true);
    state.publish.publishRunId = "301";
    state.publish.dispatchedAt = state.startedAt;
    const release = publishing(state);
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
    expect(release.readState()).toMatchObject({
      publish: { approvedGates: ["301:71"], npmVisibleAt: expect.any(String) },
      phases: { publish: { status: "completed" } },
    });
    expect(result.calls.filter((call) => call.bin === "gh")).toHaveLength(2);
  });

  it("reconciles an uncertain dispatch only for the recorded actor without repeating the mutation", () => {
    const state = publishState(true);
    delete state.operator.login;
    if (state.capabilities) {
      delete state.capabilities.childNpmPublishEnvironment;
    }
    const release = publishing(state);
    writeFileSync(
      release.stateFile,
      JSON.stringify({
        ...state,
        capabilities: { ...state.capabilities, parentApprovalReceipt: true },
      }),
    );
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
      gitShow(
        `${TOOLING_SHA}:.github/workflows/openclaw-release-publish.yml`,
        "release-approval-receipt",
      ),
      gitShow(
        `${TOOLING_SHA}:scripts/lib/release-publish-children.sh`,
        "sweep_superseded_children",
      ),
      gitShow(
        `${TOOLING_SHA}:.github/workflows/openclaw-npm-release.yml`,
        "environment: npm-publish",
      ),
      step("gh", ["api", "user", "--jq", ".login"], "release-test\n"),
      { ...parentDispatch(), exit: 1, stderr: "connection lost after submission" },
      { ...parentRuns(distractors), times: 10 },
    ]);
    expect(failed.status, failed.output).toBe(2);
    expect(failed.stdout).not.toContain("state=rejected");
    expect(release.readState().capabilities).toMatchObject({
      parentSweepsStaleChildren: true,
      childNpmPublishEnvironment: true,
    });
    expect(release.readState().capabilities).not.toHaveProperty("parentApprovalReceipt");
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
    const state = publishState(true);
    state.operator.publicationApproved = null;
    delete state.publish.macosValidateRunId;
    const release = publishing(state);
    const workflow = "openclaw-macos-validate.yml";
    const result = release.run([
      ...publishPreparation(),
      step("gh", ["workflow", "run", workflow]),
      workflowRuns(
        workflow,
        "openclaw/releases",
        [201, 211].map((id) => workflowRun(workflow, id, "macOS Validate")),
      ),
    ]);
    expect(result.status, result.output).toBe(2);
    expect(result.stderr).toContain(`Ambiguous dispatch of ${workflow}: runs 201, 211`);
    expect(result.stderr).toContain(`gh run list --repo openclaw/releases --workflow ${workflow}`);
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from publish`);
    expect(release.readState().publish.macosValidateRunId).toBeUndefined();
  });

  it.each([false, true])("bounds GET retries; never retries POST (exhausted=%s)", (exhausted) => {
    const state = publishState(true);
    state.publish.publishRunId = "301";
    const release = publishing(state);
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
  });
});

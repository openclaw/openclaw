import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  RELEASE,
  REPOSITORY,
  REPO_ROOT,
  actionRun,
  dispatchWorkflow,
  fetchMain,
  fields,
  gateApproval,
  gitShow,
  jsonStep,
  pendingGates,
  closeoutMain,
  compatibilityInventory,
  githubRelease,
  macosWait,
  postState,
  releaseFixture,
  step,
  workflowDispatch,
  workflowRun,
  workflowRuns,
} from "./release-stable.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const fixture = (state = postState("macos")) => {
  const scratch = join(REPO_ROOT, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const release = releaseFixture(directories.make(".release-stable-post-test-", scratch));
  release.seed(state);
  return release;
};
const macosRepo = "openclaw/releases";
const macosWorkflow = "openclaw-macos-publish.yml";
const closeoutAsset = `openclaw-${RELEASE}-stable-main-closeout.json`;
const closeoutAssets = (names = [closeoutAsset, `${closeoutAsset}.sha256`]) =>
  jsonStep(
    "gh",
    [
      "release",
      "view",
      `v${RELEASE}`,
      "--repo",
      REPOSITORY,
      "--json",
      "assets",
      "--jq",
      "[.assets[].name]",
    ],
    names,
  );

const websiteDispatch = () =>
  step(
    "gh",
    [
      "api",
      "--method",
      "POST",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "repos/openclaw/openclaw.ai/actions/workflows/companion-downloads-deployed.yml/dispatches",
    ],
    "503",
  );
const closeoutChecks = (conclusion = "success") => [
  ...closeoutMain(),
  closeoutAssets(),
  websiteDispatch(),
  actionRun("openclaw/openclaw.ai", 503, conclusion),
];

describe("release:stable post-publication CLI", () => {
  it.each(["already-synced", "parent", "manual"])("syncs beta using the %s path", (mode) => {
    const release = fixture();
    const state = postState("sync-beta");
    if (state.capabilities) {
      state.capabilities.parentSyncsBetaDistTag = mode === "parent";
    }
    release.seed(state);
    const tags = (beta: string) =>
      step(
        "npm",
        ["view", "openclaw", "dist-tags", "--json"],
        JSON.stringify({ latest: RELEASE, beta }),
      );
    const result = release.run([
      tags(mode === "already-synced" ? RELEASE : "2026.9.6-beta.1"),
      ...(mode === "manual"
        ? workflowDispatch("openclaw-npm-dist-tags.yml", "openclaw/releases", 401)
        : []),
      ...(mode !== "already-synced" ? [tags(RELEASE)] : []),
    ]);
    expect(result.status, result.output).toBe(0);
    expect(release.readState().phases["sync-beta"].status).toBe("completed");
    expect(release.readState().syncBeta.verifiedAt).toBeDefined();
    const dispatches = result.calls.filter(
      (call) => call.bin === "gh" && call.args[0] === "workflow",
    );
    expect(dispatches).toHaveLength(mode === "manual" ? 1 : 0);
    if (mode === "manual") {
      expect(dispatches[0]?.args).toContain("mode=sync_beta_to_stable");
      expect(dispatches[0]?.args).toContain(`tag=v${RELEASE}`);
      expect(release.readState().syncBeta.runId).toBe("401");
    }
  });

  it.each([true, false])("makes the release public only when draft=%s", (draft) => {
    const release = fixture();
    release.seed(postState("flip-github"));
    const result = release.run([
      githubRelease(draft),
      ...(draft
        ? [
            step("gh", [
              "release",
              "edit",
              `v${RELEASE}`,
              "--repo",
              REPOSITORY,
              "--draft=false",
              "--latest",
            ]),
          ]
        : []),
      githubRelease(false),
    ]);
    expect(result.status, result.output).toBe(0);
    expect(release.readState().flipGithub).toMatchObject({
      flippedBy: draft ? "orchestrator" : "parent",
      verifiedAt: expect.any(String),
    });
    expect(release.readState().phases["flip-github"].status).toBe("completed");
  });

  it("refuses macOS publication before approving gates when main lacks compatibility evidence", () => {
    const release = fixture();
    const result = release.run([
      ...compatibilityInventory("2026.9.5"),
      step("npm", ["view", `openclaw@${RELEASE}`, "dist.integrity"], "sha512-fixture"),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "pnpm update:compat:gen --release '<unpacked-dir>=sha512-fixture'",
    );
    expect(result.stderr).toContain(
      `fix(release): record the ${RELEASE} npm release in the update compatibility inventory`,
    );
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from macos`);
    expect(release.readState().publish.approvedGates).toEqual([]);
  });

  it("prints the failed preflight's notarization receipt and requires a replacement run on resume", () => {
    const release = fixture();
    const result = release.run([
      ...compatibilityInventory(),
      ...macosWait(201),
      ...macosWait(202, "failure", 3),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("resume_notarization_run_id=202");
    expect(result.stderr).toContain("resume_notarization_run_attempt=3");
    expect(result.stderr).toContain("resume_notarization_variant=all");
    expect(result.stderr).toContain("--macos-preflight-run-id '<new-run-id>'");
    expect(release.readState().macos.publishRunId).toBeUndefined();
  });

  it("publishes macOS with both verified lane IDs, approves only mac-release, and requires main's appcast", () => {
    const release = fixture();
    const result = release.run([
      ...compatibilityInventory(),
      ...macosWait(201),
      ...macosWait(202),
      githubRelease(false),
      dispatchWorkflow(macosWorkflow, macosRepo),
      workflowRuns(macosWorkflow, macosRepo, [
        {
          ...workflowRun(macosWorkflow, 202, `Preflight v${RELEASE}`),
          created_at: new Date(Date.now() + 1_000).toISOString(),
        },
        workflowRun(macosWorkflow, 203, `Publish v${RELEASE}`),
      ]),
      pendingGates(
        203,
        [
          { id: 71, name: "mac-release" },
          { id: 72, name: "npm-release" },
        ],
        macosRepo,
      ),
      gateApproval(203, 71, macosRepo),
      actionRun(macosRepo, 203),
      fetchMain(),
      gitShow(
        "origin/main:appcast.xml",
        `<sparkle:shortVersionString>${RELEASE}</sparkle:shortVersionString>`,
      ),
    ]);
    expect(result.status, result.output).toBe(0);
    const dispatch = result.calls.find((call) => call.args[0] === "workflow");
    expect(dispatch?.args).toEqual([
      ...dispatchWorkflow(macosWorkflow, macosRepo).match,
      ...fields(
        `tag=v${RELEASE}`,
        `source_ref=release/${RELEASE}`,
        `public_release_branch=release/${RELEASE}`,
        "preflight_only=false",
        "smoke_test_only=false",
        "allow_late_calver_recovery=false",
        "preflight_run_id=202",
        "validate_run_id=201",
      ),
    ]);
    expect(release.readState().macos).toMatchObject({
      validateRunId: "201",
      preflightRunId: "202",
      publishRunId: "203",
      appcastVerifiedAt: expect.any(String),
    });
    expect(release.readState().publish.approvedGates).toEqual(["203:71"]);
  });

  it("resets only macOS and closeout, retains receipts, and uses replacement lane IDs for appcast recovery", () => {
    const state = postState("macos");
    state.phases.macos = { status: "completed", completedAt: state.startedAt };
    state.phases.closeout = { status: "completed", completedAt: state.startedAt };
    state.macos = {
      validateRunId: "201",
      preflightRunId: "202",
      publishRunId: "203",
      appcastVerifiedAt: state.startedAt,
    };
    state.closeout = { runId: "501", verifiedAt: state.startedAt };
    state.publish.approvedGates = ["203:71"];
    const release = fixture(state);
    const result = release.run(
      [
        ...compatibilityInventory(),
        ...macosWait(211),
        ...macosWait(212),
        ...macosWait(203),
        fetchMain(),
        gitShow("origin/main:appcast.xml", `<version>${RELEASE}0</version>`),
        jsonStep(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            REPOSITORY,
            "--search",
            `chore(release): update appcast for ${RELEASE} in:title`,
            "--state",
            "open",
            "--json",
            "number,url",
          ],
          [{ number: 42, url: `https://github.com/${REPOSITORY}/pull/42` }],
        ),
      ],
      ["--from", "macos", "--macos-validate-run-id", "211", "--macos-preflight-run-id", "212"],
    );
    expect(result.status, result.output).toBe(2);
    expect(result.stderr).toContain(`# Merge appcast PR https://github.com/${REPOSITORY}/pull/42`);
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from macos`);
    expect(result.stderr).toContain("--macos-preflight-run-id 212 --macos-validate-run-id 211");
    const retained = release.readState();
    for (const phase of ["cut", "validate", "publish", "sync-beta", "flip-github"] as const) {
      expect(retained.phases[phase]).toEqual(state.phases[phase]);
    }
    expect(retained.phases.macos.status).toBe("refused");
    expect(retained.phases.closeout).toEqual({ status: "pending" });
    expect(retained.closeout).toEqual(state.closeout);
    expect(retained.publish).toEqual(state.publish);
    expect(retained.macos).toMatchObject({
      validateRunId: "211",
      preflightRunId: "212",
      publishRunId: "203",
    });
    expect(retained.history.map(({ phase, event }) => ({ phase, event }))).toEqual([
      { phase: "macos", event: "reset" },
      { phase: "closeout", event: "reset" },
    ]);
    expect(retained.history.map(({ detail }) => JSON.parse(detail ?? "null"))).toEqual([
      { phase: state.phases.macos, data: state.macos },
      { phase: state.phases.closeout, data: state.closeout },
    ]);
    expect(result.calls.some((call) => call.args[0] === "workflow")).toBe(false);
  });

  it.each([
    { version: "2026.9.5", notes: `## ${RELEASE}\n`, label: "version" },
    { version: RELEASE, notes: `## ${RELEASE}\nDifferent notes.\n`, label: "changelog bytes" },
  ])(
    "refuses closeout when main's $label differs from the shipped release",
    ({ version, notes }) => {
      const release = fixture(postState("closeout"));
      const result = release.run(closeoutMain(version, notes));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "Main does not carry the shipped version and exact changelog.",
      );
      expect(result.stderr).toContain(`release/${RELEASE}-main-closeout`);
      expect(result.stderr).toContain(`pnpm release:prepare -- --version ${RELEASE} --write`);
      for (const file of [`CHANGELOG/${RELEASE}.md`, `CHANGELOG/records/${RELEASE}.md`]) {
        expect(result.stderr).toContain(`git show v${RELEASE}:${file} > ${file}\n`);
      }
      expect(result.stderr).toContain("pnpm release:generated:check");
      expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from closeout`);
      expect(release.readState().closeout.runId).toBeUndefined();
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])("verifies closeout (dispatch=%s, restart=%s)", (dispatch, restart) => {
    const state = postState("closeout");
    if (restart) {
      state.closeout = { websiteRunId: "499", verifiedAt: state.startedAt };
    }
    const release = fixture(state);
    const result = release.run(
      [
        ...closeoutMain(),
        ...(dispatch
          ? [
              closeoutAssets([]),
              ...workflowDispatch(
                "openclaw-stable-main-closeout.yml",
                REPOSITORY,
                502,
                "Stable main closeout",
              ),
              actionRun(REPOSITORY, 502),
            ]
          : []),
        closeoutAssets(),
        websiteDispatch(),
        actionRun("openclaw/openclaw.ai", 503),
      ],
      restart ? ["--from", "closeout"] : [],
    );
    expect(result.status, result.output).toBe(0);
    expect(release.readState().phases.closeout.status).toBe("completed");
    expect(release.readState().closeout).toMatchObject({
      publishRunConclusion: "success",
      verifiedAt: expect.any(String),
    });
    if (dispatch) {
      expect(result.calls.find((call) => call.args[0] === "workflow")?.args.slice(7)).toEqual([
        "-f",
        `tag=v${RELEASE}`,
      ]);
      expect(release.readState().closeout.runId).toBe("502");
    } else {
      expect(release.readState().closeout.runId).toBeUndefined();
      expect(result.calls.filter((call) => call.args[0] === "workflow")).toHaveLength(0);
      expect(release.readState().closeout.websiteRunId).toBe("503");
      expect(result.stdout).not.toContain("OPENCLAW_FRV_LANE_WAIVER");
    }
    if (restart) {
      expect(result.calls.flatMap(({ args }) => args)).not.toContain(
        "repos/openclaw/openclaw.ai/actions/runs/499",
      );
    }
  });

  it("keeps closeout incomplete when the website verification fails despite existing receipts", () => {
    const release = fixture(postState("closeout"));
    const result = release.run(closeoutChecks("failure"));
    expect(result.status, result.output).toBe(2);
    expect(result.stderr).toContain("Website verification 503 concluded failure");
    const refused = release.readState();
    expect(refused.phases.closeout.status).toBe("refused");
    expect([refused.closeout.verifiedAt, refused.closeout.websiteRunId]).toEqual([
      undefined,
      undefined,
    ]);
    const resumed = release.run(closeoutChecks(), ["--from", "closeout"]);
    expect(resumed.status, resumed.output).toBe(0);
    expect(release.readState().phases.closeout.status).toBe("completed");
  });

  it.each([closeoutAsset, `${closeoutAsset}.sha256`])("refuses closeout with only %s", (name) => {
    const names = [name];
    const state = postState("closeout");
    state.closeout.runId = "501";
    const release = fixture(state);
    const result = release.run([
      ...closeoutMain(),
      closeoutAssets(names),
      actionRun(REPOSITORY, 501),
      closeoutAssets(names),
    ]);
    expect(result.status, result.output).toBe(2);
    expect(result.stderr).toContain(
      "Closeout run 501 succeeded but required release assets are missing.",
    );
    expect(result.stderr).toContain(`gh run view 501 --repo ${REPOSITORY} --log-failed`);
    expect(result.stderr).toContain(`pnpm release:stable ${RELEASE} --from closeout`);
    expect(release.readState().phases.closeout.status).toBe("refused");
    expect(release.readState().closeout).toEqual({
      publishRunConclusion: "success",
      runId: "501",
    });
    expect(result.calls.some((call) => call.args[0] === "workflow")).toBe(false);
  });
});

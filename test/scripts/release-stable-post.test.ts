import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  RELEASE,
  REPOSITORY,
  REPO_ROOT,
  actionRun,
  closeoutMain,
  compatibilityInventory,
  githubRelease,
  macosWait,
  postState,
  releaseFixture,
  step,
  workflowDispatch,
} from "./release-stable.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const fixture = () => {
  const scratch = join(REPO_ROOT, ".tmp");
  mkdirSync(scratch, { recursive: true });
  return releaseFixture(directories.make(".release-stable-post-test-", scratch));
};
const fetchMain = () => step("git", ["fetch", "origin", "main:refs/remotes/origin/main"]);
const closeoutAssets = (
  names = [
    `openclaw-${RELEASE}-stable-main-closeout.json`,
    `openclaw-${RELEASE}-stable-main-closeout.json.sha256`,
  ],
) =>
  step(
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
    JSON.stringify(names),
  );

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
    release.seed(postState("macos"));
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
    release.seed(postState("macos"));
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
    release.seed(postState("macos"));
    const result = release.run([
      ...compatibilityInventory(),
      ...macosWait(201),
      ...macosWait(202),
      githubRelease(false),
      step("gh", [
        "workflow",
        "run",
        "openclaw-macos-publish.yml",
        "--repo",
        "openclaw/releases",
        "--ref",
        "main",
      ]),
      step(
        "gh",
        [
          "api",
          "repos/openclaw/releases/actions/workflows/openclaw-macos-publish.yml/runs?event=workflow_dispatch&per_page=10",
        ],
        JSON.stringify({
          workflow_runs: [
            {
              id: 202,
              path: ".github/workflows/openclaw-macos-publish.yml",
              event: "workflow_dispatch",
              actor: { login: "release-test" },
              head_branch: "main",
              display_title: `Preflight v${RELEASE}`,
              created_at: new Date(Date.now() + 1_000).toISOString(),
            },
            {
              id: 203,
              path: ".github/workflows/openclaw-macos-publish.yml",
              event: "workflow_dispatch",
              actor: { login: "release-test" },
              head_branch: "main",
              display_title: `Publish v${RELEASE}`,
              created_at: new Date().toISOString(),
            },
          ],
        }),
      ),
      step(
        "gh",
        ["api", "repos/openclaw/releases/actions/runs/203/pending_deployments"],
        JSON.stringify([
          { environment: { id: 71, name: "mac-release" } },
          { environment: { id: 72, name: "npm-release" } },
        ]),
      ),
      step("gh", [
        "api",
        "-X",
        "POST",
        "repos/openclaw/releases/actions/runs/203/pending_deployments",
        "-f",
        "state=approved",
        "-f",
        `comment=${RELEASE} stable publish approved by release-test`,
        "-F",
        "environment_ids[]=71",
      ]),
      actionRun("openclaw/releases", 203),
      fetchMain(),
      step(
        "git",
        ["show", "origin/main:appcast.xml"],
        `<sparkle:shortVersionString>${RELEASE}</sparkle:shortVersionString>`,
      ),
    ]);
    expect(result.status, result.output).toBe(0);
    const dispatch = result.calls.find((call) => call.args[0] === "workflow");
    expect(dispatch?.args).toEqual([
      "workflow",
      "run",
      "openclaw-macos-publish.yml",
      "--repo",
      "openclaw/releases",
      "--ref",
      "main",
      "-f",
      `tag=v${RELEASE}`,
      "-f",
      `source_ref=release/${RELEASE}`,
      "-f",
      `public_release_branch=release/${RELEASE}`,
      "-f",
      "preflight_only=false",
      "-f",
      "smoke_test_only=false",
      "-f",
      "allow_late_calver_recovery=false",
      "-f",
      "preflight_run_id=202",
      "-f",
      "validate_run_id=201",
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
    const release = fixture();
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
    release.seed(state);
    const result = release.run(
      [
        ...compatibilityInventory(),
        ...macosWait(211),
        ...macosWait(212),
        ...macosWait(203),
        fetchMain(),
        step("git", ["show", "origin/main:appcast.xml"], `<version>${RELEASE}0</version>`),
        step(
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
          JSON.stringify([{ number: 42, url: `https://github.com/${REPOSITORY}/pull/42` }]),
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
    expect(JSON.parse(retained.history[0]?.detail ?? "null")).toEqual({
      phase: state.phases.macos,
      data: state.macos,
    });
    expect(JSON.parse(retained.history[1]?.detail ?? "null")).toEqual({
      phase: state.phases.closeout,
      data: state.closeout,
    });
    expect(result.calls.some((call) => call.args[0] === "workflow")).toBe(false);
  });

  it.each([
    { version: "2026.9.5", notes: `## ${RELEASE}\n`, label: "version" },
    { version: RELEASE, notes: `## ${RELEASE}\nDifferent notes.\n`, label: "changelog bytes" },
  ])(
    "refuses closeout when main's $label differs from the shipped release",
    ({ version, notes }) => {
      const release = fixture();
      release.seed(postState("closeout"));
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

  it("completes closeout from release assets without dispatching or waiting for a closeout run", () => {
    const release = fixture();
    release.seed(postState("closeout"));
    const result = release.run([...closeoutMain(), closeoutAssets()]);
    expect(result.status, result.output).toBe(0);
    expect(release.readState().closeout).toMatchObject({
      publishRunConclusion: "success",
      verifiedAt: expect.any(String),
    });
    expect(release.readState().phases.closeout.status).toBe("completed");
    expect(release.readState().closeout.runId).toBeUndefined();
    expect(result.calls.some((call) => call.args[0] === "workflow")).toBe(false);
    expect(result.stdout).not.toContain("OPENCLAW_FRV_LANE_WAIVER");
  });

  it("dispatches closeout using only its immutable tag", () => {
    const release = fixture();
    const state = postState("closeout");
    release.seed(state);
    const result = release.run([
      ...closeoutMain(),
      closeoutAssets([]),
      ...workflowDispatch(
        "openclaw-stable-main-closeout.yml",
        REPOSITORY,
        502,
        "Stable main closeout",
      ),
      actionRun(REPOSITORY, 502),
      closeoutAssets(),
    ]);
    expect(result.status, result.output).toBe(0);
    const dispatch = result.calls.find((call) => call.args[0] === "workflow");
    expect(dispatch?.args.slice(7)).toEqual(["-f", `tag=v${RELEASE}`]);
    expect(release.readState().phases.closeout.status).toBe("completed");
    expect(release.readState().closeout).toMatchObject({
      runId: "502",
      verifiedAt: expect.any(String),
    });
  });

  it.each([
    { label: "neither asset", names: [] },
    { label: "only the evidence", names: [`openclaw-${RELEASE}-stable-main-closeout.json`] },
    {
      label: "only the checksum",
      names: [`openclaw-${RELEASE}-stable-main-closeout.json.sha256`],
    },
  ])("refuses a successful closeout with $label", ({ names }) => {
    const release = fixture();
    const state = postState("closeout");
    state.closeout.runId = "501";
    release.seed(state);
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

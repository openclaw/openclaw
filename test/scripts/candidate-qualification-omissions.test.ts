import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildFrozenTargetWorkflowRequest } from "../../scripts/lib/frozen-target-workflow-request.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
function step(job: string, name: string) {
  const selected = workflow.jobs[job].steps.find((entry: { name?: string }) => entry.name === name);
  if (!selected) {
    throw new Error("Missing actual child dispatch step");
  }
  return selected;
}

// Exercise the workflow adapter: release context is not permission to omit
// candidate-owned scenarios, while explicit cross-revision diagnostics remain.
describe("frozen qualification workflow request", () => {
  it.each([
    { distinct: false, context: true, explicit: false, omissions: false },
    { distinct: true, context: true, explicit: false, omissions: true },
    { distinct: true, context: false, explicit: false, omissions: false },
    { distinct: false, context: true, explicit: true, omissions: true },
  ])("selects omission mode for %j", ({ distinct, context, explicit, omissions }) => {
    const result = buildFrozenTargetWorkflowRequest({
      ...process.env,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: "77",
      GITHUB_RUN_ATTEMPT: "1",
      ADMISSION_WORKFLOW: "parent",
      ADMISSION_WORKFLOW_REF: "refs/heads/release-ci/aaaaaaaaaaaa-1",
      ADMISSION_SELECTED_ROOT: ".",
      ADMISSION_SELECTED_SHA: "a".repeat(40),
      ADMISSION_TOOLING_ROOT: ".",
      ADMISSION_TOOLING_SHA: (distinct ? "b" : "a").repeat(40),
      ADMISSION_INPUTS: JSON.stringify({
        ref: "a".repeat(40),
        target_context_ref: context ? "release/2026.9.7" : "",
        allow_frozen_target_scenario_omissions: explicit,
      }),
    });
    expect(result.allowFrozenTargetScenarioOmissions).toBe(omissions);
  });
});

describe("candidate qualification child dispatch", () => {
  it.each([false, true])(
    "seals canonical omission authorization (cross revision=%s)",
    (distinct) => {
      const root = tempDirs.make("release-canonical-qualification-");
      // The real CLI checks its physical entrypoint; a symlink would import it
      // without executing main and would not model an Actions checkout.
      for (const path of [
        "scripts/full-release-candidate-contract.mjs",
        "scripts/lib/canonical-json.mjs",
        "scripts/lib/record-shared.mjs",
        "scripts/lib/upgrade-survivor-policy.mjs",
        "scripts/lib/upgrade-survivor-scenarios.json",
        "scripts/lib/release-version.mjs",
      ]) {
        const destination = join(root, "workflow", path);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(path, destination);
      }
      execFileSync(
        "bash",
        ["-c", String(step("resolve_target", "Build canonical release candidate request").run)],
        {
          cwd: root,
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            GITHUB_OUTPUT: join(root, "output"),
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_SHA: (distinct ? "b" : "a").repeat(40),
            TARGET_SHA: "a".repeat(40),
            TARGET_CONTEXT_REF: "release/2026.9.7",
            RELEASE_PROFILE: "beta",
            RELEASE_SOAK: "false",
            QUALIFICATION_ADMISSION_JSON: "",
            QUALIFICATION_BASELINES_JSON: "",
            UPGRADE_SURVIVOR_SCENARIOS: "",
            ALLOW_UNRELEASED_CHANGELOG: "true",
            PACKAGE_PUBLISHED: "false",
            RELEASE_PACKAGE_SPEC: "",
            PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "",
            RERUN_GROUP: "all",
            LIVE_SUITE_FILTER: "",
            // This is the original workflow expression's value for a nonempty release context.
            ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "true",
          },
        },
      );
      const request = JSON.parse(
        readFileSync(join(root, "full-release-candidate-request.json"), "utf8"),
      );
      expect(request.allowFrozenTargetScenarioOmissions).toBe(distinct);
    },
  );

  it.each([
    ["plugin-prerelease", false],
    ["plugin-prerelease", true],
    ["release-checks", false],
    ["release-checks", true],
  ] as const)(
    "keeps release context without equal-SHA omissions in %s (cross revision=%s)",
    (kind, distinct) => {
      const root = tempDirs.make("release-qualification-inputs-");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const calls = join(root, "calls");
      const sha = (distinct ? "b" : "a").repeat(40);
      const ref = "release-ci/" + sha.slice(0, 12) + "-1";
      const title =
        (kind === "plugin-prerelease" ? "Plugin Prerelease" : "OpenClaw Release Checks") +
        " full-release-validation-77-1-" +
        kind +
        "-independent";
      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        `#!` +
          process.execPath +
          `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'workflow') console.log('https://github.com/openclaw/openclaw/actions/runs/202');
else if (args[1].includes('/commits/')) console.log(process.env.PARENT_WORKFLOW_SHA);
else if (args[1].includes('/actions/workflows/')) console.log('88');
else console.log(JSON.stringify({id:202,workflow_id:88,head_branch:process.env.CHILD_WORKFLOW_REF,
  event:'workflow_dispatch',display_title:process.env.TEST_TITLE,head_sha:process.env.PARENT_WORKFLOW_SHA,
  run_attempt:1,html_url:'https://github.com/openclaw/openclaw/actions/runs/202'}));
`,
      );
      chmodSync(gh, 0o755);
      execFileSync("bash", ["-c", String(step("normal_ci", "Dispatch CI").run)], {
        cwd: root,
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: bin + delimiter + process.env.PATH,
          CALLS: calls,
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "77",
          GITHUB_RUN_ATTEMPT: "1",
          CHILD_EVIDENCE_REUSE: "false",
          CHILD_WORKFLOW_KIND: kind,
          CHILD_WORKFLOW_REF: ref,
          PARENT_WORKFLOW_SHA: sha,
          TARGET_SHA: "a".repeat(40),
          TARGET_REF: "a".repeat(40),
          TARGET_CONTEXT_REF: "release/2026.9.7",
          PHASE: "independent",
          TEST_TITLE: title,
          PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON: "[]",
          EXTENSION_TEST_EXCLUDE_PATTERNS_JSON: "[]",
          CANDIDATE_ARTIFACT_JSON: "",
          PROVIDER: "openai",
          MODE: "both",
          RELEASE_PROFILE: "stable",
          RUN_RELEASE_SOAK: "true",
          FAIL_FAST: "false",
          ALLOW_UNRELEASED_CHANGELOG: "false",
          SKIP_PACKAGE_TELEGRAM_E2E: "false",
          TELEGRAM_WAIVER: "",
          RERUN_GROUP: "all",
          LIVE_SUITE_FILTER: "",
          CROSS_OS_SUITE_FILTER: "",
          RELEASE_PACKAGE_SPEC: "",
          PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "",
          CODEX_PLUGIN_SPEC: "",
        },
      });
      const dispatch = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .find((args) => args[0] === "workflow")!;
      expect(dispatch).toContain("target_context_ref=release/2026.9.7");
      expect(dispatch).toContain(ref);
      expect(dispatch.includes("allow_frozen_target_scenario_omissions=true")).toBe(distinct);
    },
  );
});

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildFrozenTargetWorkflowRequest } from "../../scripts/lib/frozen-target-workflow-request.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readWorkflow, requiredWorkflowStep } from "./ci-workflow.test-support.js";
import { readFixtureJson } from "./z0632-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflow = readWorkflow(".github/workflows/full-release-validation.yml");
const targetSha = "a".repeat(40);
const contextRef = "release/2026.9.7";
function workflowEnv() {
  return {
    ...process.env,
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_RUN_ID: "77",
    GITHUB_RUN_ATTEMPT: "1",
    TARGET_SHA: targetSha,
    TARGET_CONTEXT_REF: contextRef,
    RERUN_GROUP: "all",
    LIVE_SUITE_FILTER: "",
    RELEASE_PACKAGE_SPEC: "",
    PACKAGE_ACCEPTANCE_PACKAGE_SPEC: "",
  };
}

function emptyInputs(names: string) {
  return Object.fromEntries(names.split(" ").map((name) => [name, ""]));
}

function step(job: string, name: string) {
  return requiredWorkflowStep(workflow.jobs[job].steps, name);
}

it.each([
  { distinct: false, context: true, explicit: false, omissions: false },
  { distinct: true, context: true, explicit: false, omissions: true },
  { distinct: true, context: false, explicit: false, omissions: false },
  { distinct: false, context: true, explicit: true, omissions: true },
])("selects omission mode for %j", ({ distinct, context, explicit, omissions }) => {
  const result = buildFrozenTargetWorkflowRequest({
    ...workflowEnv(),
    ADMISSION_WORKFLOW: "parent",
    ADMISSION_WORKFLOW_REF: "refs/heads/release-ci/aaaaaaaaaaaa-1",
    ADMISSION_SELECTED_ROOT: ".",
    ADMISSION_SELECTED_SHA: targetSha,
    ADMISSION_TOOLING_ROOT: ".",
    ADMISSION_TOOLING_SHA: (distinct ? "b" : "a").repeat(40),
    ADMISSION_INPUTS: JSON.stringify({
      ref: targetSha,
      target_context_ref: context ? contextRef : "",
      allow_frozen_target_scenario_omissions: explicit,
    }),
  });
  expect(result.allowFrozenTargetScenarioOmissions).toBe(omissions);
});
it.each([false, true])("seals canonical omission authorization (cross revision=%s)", (distinct) => {
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
        ...workflowEnv(),
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_SHA: (distinct ? "b" : "a").repeat(40),
        RELEASE_PROFILE: "beta",
        RELEASE_SOAK: "false",
        ...emptyInputs(
          "QUALIFICATION_ADMISSION_JSON QUALIFICATION_BASELINES_JSON UPGRADE_SURVIVOR_SCENARIOS",
        ),
        ALLOW_UNRELEASED_CHANGELOG: "true",
        PACKAGE_PUBLISHED: "false",
        // This is the original workflow expression's value for a nonempty release context.
        ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "true",
      },
    },
  );
  const request = readFixtureJson(root, "full-release-candidate-request.json");
  expect(request.allowFrozenTargetScenarioOmissions).toBe(distinct);
});

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
    const ref = `release-ci/${sha.slice(0, 12)}-1`;
    const titlePrefix =
      kind === "plugin-prerelease" ? "Plugin Prerelease" : "OpenClaw Release Checks";
    const title = `${titlePrefix} full-release-validation-77-1-${kind}-independent`;
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
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
        ...workflowEnv(),
        PATH: bin + delimiter + process.env.PATH,
        CALLS: calls,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        CHILD_EVIDENCE_REUSE: "false",
        CHILD_WORKFLOW_KIND: kind,
        CHILD_WORKFLOW_REF: ref,
        PARENT_WORKFLOW_SHA: sha,
        TARGET_REF: targetSha,
        PHASE: "independent",
        TEST_TITLE: title,
        PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON: "[]",
        EXTENSION_TEST_EXCLUDE_PATTERNS_JSON: "[]",
        ...emptyInputs("CANDIDATE_ARTIFACT_JSON CROSS_OS_SUITE_FILTER CODEX_PLUGIN_SPEC"),
        PROVIDER: "openai",
        MODE: "both",
        RELEASE_PROFILE: "stable",
        RUN_RELEASE_SOAK: "true",
        FAIL_FAST: "false",
        ALLOW_UNRELEASED_CHANGELOG: "false",
        SKIP_PACKAGE_TELEGRAM_E2E: "false",
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

it.each([false, true])(
  "adopts child evidence with current policy without dispatch (admitted P=%s)",
  (admitted) => {
    const root = tempDirs.make("release-reuse-policy-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls");
    const node = join(bin, "node");
    writeFileSync(
      node,
      `#!` +
        process.execPath +
        `
const fs = require('node:fs');
fs.writeFileSync(process.env.CALLS, JSON.stringify({args: process.argv.slice(2), version: process.env.TARGET_VERSION, directory: process.env.CHILD_WORKFLOW_DIRECTORY}));
`,
    );
    chmodSync(node, 0o755);
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
exit 91
`,
    );
    chmodSync(gh, 0o755);
    const run = String(step("normal_ci", "Dispatch CI").run)
      .replaceAll(
        "${{ fromJSON(needs.resolve_target.outputs.source_admission_json || '{}').qualificationAdmission != null }}",
        String(admitted),
      )
      .replaceAll("${{ needs.resolve_target.outputs.target_version }}", "2026.9.23");
    execFileSync("bash", ["-c", run], {
      cwd: root,
      timeout: 10_000,
      env: {
        ...workflowEnv(),
        PATH: bin + delimiter + process.env.PATH,
        CALLS: calls,
        GITHUB_WORKSPACE: root,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        CHILD_EVIDENCE_REUSE: "true",
        CHILD_WORKFLOW_KIND: "ci",
        TARGET_REF: targetSha,
      },
    });
    const observed = JSON.parse(readFileSync(calls, "utf8"));
    expect(observed).toMatchObject({
      version: "2026.9.23",
      directory: join(root, "workflow/.github/workflows"),
    });
    expect(observed.args.slice(0, 2)).toEqual([
      (admitted ? "qualification-verifier" : "workflow") +
        "/scripts/find-reusable-release-child.mjs",
      "ci.yml",
    ]);
    expect(observed.args).toContain("target_ref=" + targetSha);
    for (const job of [
      "normal_ci",
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "release_checks_independent",
      "release_checks_candidate",
      "npm_telegram",
      "performance",
    ]) {
      expect(step(job, "Checkout admitted qualification verifier").with).toMatchObject({
        path: "qualification-verifier",
      });
    }
  },
);

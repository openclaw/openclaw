import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/validate-release-publish-approval.mjs";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);
// Android publication runs on Ubuntu and executes Bash workflow steps.
const androidIt = it.skipIf(process.platform === "win32");

const approvalEnv = {
  ALLOW_COMPLETED_SUCCESSFUL_PARENT: "false",
  CHILD_WORKFLOW_SHA: "b".repeat(40),
  DIRECT_RELEASE_RECOVERY: "false",
  EXPECTED_WORKFLOW_BRANCH: "release/2026.6.21",
  EXPECTED_WORKFLOW_FULL_REF: "",
  EXPECTED_WORKFLOW_SHA: "",
  EXPECTED_RUN_ATTEMPT: "",
  APPROVAL_PATH: "",
  GITHUB_REPOSITORY: "openclaw/openclaw",
  RELEASE_APPROVAL_KIND: "android",
  RELEASE_PACKAGES: "",
  RELEASE_TAG: "v2026.6.21",
  RELEASE_PUBLISH_RUN_ID: "123",
  RELEASE_TARGET_SHA: "a".repeat(40),
};

function runApprovalScript(
  run: Record<string, unknown>,
  overrides: Partial<typeof approvalEnv> = {},
) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...approvalEnv,
      ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
    },
    input: JSON.stringify(run),
  });
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}

const ANDROID_TOOLING_SHA = "d".repeat(40);
const ANDROID_PROTECTED_REF = `release-publish/${ANDROID_TOOLING_SHA.slice(0, 12)}-123`;
const ANDROID_ASSETS = ["OpenClaw-Android.apk", "OpenClaw-Android-SHA256SUMS.txt"];
const FAILED_PARENT = { status: "completed", conclusion: "failure" };
type Fields = Record<string, unknown>;
type Publication = {
  afterAdmission?: Fields;
  afterFirstUpload?: Fields;
  afterToolingRead?: Fields;
  nativeCiAfterAdmission?: Fields;
  nativeCiAfterAssetLookup?: Fields;
  nativeCiAfterFirstUpload?: Fields;
  nativeCiAfterToolingRead?: Fields;
  release?: Fields;
  beforeProvenance?: boolean;
  targetSha?: string;
};

function workflowStep(file: string, name: string): string {
  const workflow = parse(fs.readFileSync(file, "utf8"));
  const steps = Object.values(workflow.jobs).flatMap(
    (job) => (job as { steps?: { name?: string; run?: string }[] }).steps ?? [],
  );
  const step = steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing workflow step ${name}`);
  }
  return step.run;
}

function runWorkflowStep(file: string, name: string, env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync("bash", ["-c", workflowStep(file, name)], { encoding: "utf8", env, cwd });
}

function runAndroidApproval({
  ref = ANDROID_PROTECTED_REF,
  approval = {},
  run = {},
  identity,
  recovery = false,
  attestationExitCode = 0,
  release = {},
  targetSha = "a".repeat(40),
  nativeCi,
  publication,
}: {
  ref?: string;
  approval?: Fields;
  run?: Fields;
  identity?: Fields;
  recovery?: boolean;
  attestationExitCode?: number;
  release?: Fields;
  targetSha?: string;
  nativeCi?: Fields;
  publication?: Publication;
} = {}) {
  const tempRoot = tempRoots.make("openclaw-android-approval-");
  const at = (name: string) => path.join(tempRoot, name);
  const scripts = path.resolve("scripts");
  fs.mkdirSync(at(".release-harness"));
  fs.symlinkSync(scripts, at(".release-harness/scripts"), "dir");
  const fullRef = `${ref.startsWith("release-publish/") ? "refs/tags" : "refs/heads"}/${ref}`;
  const approvalPath = path.join(tempRoot, "android-release-approval/approval.json");
  const env = {
    ...process.env,
    PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
    APPROVAL_PATH: approvalPath,
    DIRECT_RELEASE_RECOVERY: String(recovery),
    EXPECTED_WORKFLOW_BRANCH: ref,
    EXPECTED_WORKFLOW_FULL_REF: fullRef,
    EXPECTED_WORKFLOW_SHA: ANDROID_TOOLING_SHA,
    EXPECTED_RUN_ATTEMPT: "2",
    RELEASE_PUBLISH_BRANCH: ref,
    RELEASE_PUBLISH_FULL_REF: fullRef,
    RELEASE_PUBLISH_WORKFLOW_SHA: ANDROID_TOOLING_SHA,
    RELEASE_PUBLISH_RUN_ATTEMPT: "2",
    RELEASE_PUBLISH_RUN_ID: "123",
    RELEASE_APPROVAL_KIND: "android",
    RELEASE_TAG: "v2026.8.1",
    RELEASE_TARGET_SHA: "a".repeat(40),
    TARGET_SHA: "a".repeat(40),
    RELEASE_COVERAGE_POLICY: nativeCi ? "npm-stable-v1" : "full",
    NATIVE_CI_RUN_ID: nativeCi ? "91" : "",
    NATIVE_CI_WORKFLOW_REF: nativeCi ? ANDROID_PROTECTED_REF : "",
    GITHUB_REF: "refs/tags/v2026.8.1",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    RUNNER_TEMP: tempRoot,
    GITHUB_OUTPUT: path.join(tempRoot, "output"),
  };
  const parent = {
    id: 123,
    repository: { full_name: "openclaw/openclaw" },
    event: "workflow_dispatch",
    head_branch: ref,
    head_sha: ANDROID_TOOLING_SHA,
    run_attempt: 2,
    path: `.github/workflows/openclaw-release-publish.yml@${fullRef}`,
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
    ...run,
  };
  const tooling =
    identity ??
    (ref === "main"
      ? { status: "ahead" }
      : {
          ref: fullRef,
          object: { type: "commit", sha: ANDROID_TOOLING_SHA },
        });
  const identityEndpoint =
    ref === "main"
      ? `compare/${ANDROID_TOOLING_SHA}...main`
      : `git/ref/${ref.startsWith("release-publish/") ? "tags" : "heads"}/${ref}`;
  const parentPath = path.join(tempRoot, "parent.json");
  const nativeCiPath = path.join(tempRoot, "native-ci.json");
  const targetPath = path.join(tempRoot, "target.json");
  const effectsPath = path.join(tempRoot, "uploads.json");
  const execute = (workflow: string, step: string, cwd?: string) =>
    runWorkflowStep(`.github/workflows/${workflow}.yml`, step, env, cwd);
  writeJson(parentPath, parent);
  const nativeRun = {
    id: 91,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: ".github/workflows/ci.yml",
    display_title: `CI release-native-android-123-2-${"a".repeat(40)}`,
    head_branch: ANDROID_PROTECTED_REF,
    head_sha: ANDROID_TOOLING_SHA,
    repository: { full_name: "openclaw/openclaw" },
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
    status: "completed",
    conclusion: "success",
  };
  writeJson(nativeCiPath, nativeRun);
  writeJson(targetPath, {
    sha: targetSha,
    release: {
      tagName: "v2026.8.1",
      isDraft: true,
      isPrerelease: false,
      createdAt: "2026-08-30T12:00:00Z",
      assets: [],
      ...release,
    },
  });
  fs.writeFileSync(effectsPath, "[]");
  writeJson(path.join(tempRoot, "fixture.json"), {
    publication: publication ?? {},
    parent,
    nativeRun,
    identityEndpoint: `repos/openclaw/openclaw/${identityEndpoint}`,
    tooling,
    attestationExitCode,
  });
  fs.writeFileSync(
    path.join(tempRoot, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const file = name => path.join(process.env.RUNNER_TEMP, name);
const {publication, parent, nativeRun, identityEndpoint, tooling, attestationExitCode} = require(file("fixture.json"));
const publishing = fs.existsSync(file("publishing"));
function replace(file, base, phase) {
  if (publication[phase]) fs.writeFileSync(file, JSON.stringify({ ...base, ...publication[phase] }));
}
function output(text) { process.stdout.write(text); process.exit(0); }
if (args[0] === "attestation" && args[1] === "verify") {
  process.exit(attestationExitCode);
}
if (args[0] === "release" && args[1] === "view") {
  if (args.includes("assets") && publishing) replace(file("native-ci.json"), nativeRun, "nativeCiAfterAssetLookup");
  output(JSON.stringify(JSON.parse(fs.readFileSync(file("target.json"), "utf8")).release));
}
if (args[0] === "release" && args[1] === "upload") {
  const effects = JSON.parse(fs.readFileSync(file("uploads.json"), "utf8"));
  effects.push(args[3]);
  fs.writeFileSync(file("uploads.json"), JSON.stringify(effects));
  if (effects.length === 1) {
    replace(file("parent.json"), parent, "afterFirstUpload");
    replace(file("native-ci.json"), nativeRun, "nativeCiAfterFirstUpload");
  }
  process.exit(0);
}
const runs = { "repos/openclaw/openclaw/actions/runs/123": file("parent.json"),
  "repos/openclaw/openclaw/actions/runs/91": file("native-ci.json") };
if (args[0] === "api" && runs[args[1]]) output(fs.readFileSync(runs[args[1]], "utf8"));
if (args[0] !== "api" || args[1] !== identityEndpoint) process.exit(91);
if (publishing) {
  replace(file("parent.json"), parent, "afterToolingRead");
  replace(file("native-ci.json"), nativeRun, "nativeCiAfterToolingRead");
}
process.stdout.write(JSON.stringify(tooling));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tempRoot, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const target = JSON.parse(fs.readFileSync(${JSON.stringify(targetPath)}, "utf8"));
if (JSON.stringify(args) === JSON.stringify(["rev-parse", "v2026.8.1^{commit}"])) {
  process.stdout.write(target.sha);
} else if (JSON.stringify(args) === JSON.stringify(["ls-remote", "--tags", "origin", "refs/tags/v2026.8.1", "refs/tags/v2026.8.1^{}"])) {
  process.stdout.write(${JSON.stringify("e".repeat(40) + "\trefs/tags/v2026.8.1\n")} + target.sha + ${JSON.stringify("\trefs/tags/v2026.8.1^{}\n")});
} else process.exit(91);
`,
    { mode: 0o755 },
  );
  const producer = execute("openclaw-release-publish", "Write Android release approval", tempRoot);
  expect(producer.status, producer.stderr).toBe(0);
  writeJson(approvalPath, { ...JSON.parse(fs.readFileSync(approvalPath, "utf8")), ...approval });
  writeJson(nativeCiPath, { ...nativeRun, ...nativeCi });
  let result = execute("android-release", "Validate release approval and target");
  if (publication) {
    expect(result.status, result.stderr).toBe(0);
    writeJson(parentPath, { ...parent, ...publication.afterAdmission });
    writeJson(nativeCiPath, { ...nativeRun, ...publication.nativeCiAfterAdmission });
    const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    writeJson(targetPath, {
      sha: publication.targetSha ?? target.sha,
      release: { ...target.release, ...publication.release },
    });
    fs.writeFileSync(path.join(tempRoot, "publishing"), "");
    fs.symlinkSync(scripts, at("scripts"), "dir");
    fs.mkdirSync(path.join(tempRoot, "dist"));
    for (const name of ANDROID_ASSETS) {
      fs.writeFileSync(path.join(tempRoot, "dist", name), "fixture");
    }
    result = execute(
      "android-release",
      publication.beforeProvenance
        ? "Revalidate release approval before Android provenance"
        : "Upload immutable Android release assets",
      tempRoot,
    );
  }
  return {
    ...result,
    uploads: JSON.parse(fs.readFileSync(effectsPath, "utf8")),
  };
}

function rejectAndroid(options: Parameters<typeof runAndroidApproval>[0]) {
  const result = runAndroidApproval(options);
  expect(result.status, result.stderr).toBe(1);
  expect(result.uploads).toEqual([]);
  return result;
}
type AndroidOptions = NonNullable<Parameters<typeof runAndroidApproval>[0]>;

function approvalRun(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: null,
    event: "workflow_dispatch",
    headBranch: "release/2026.6.21",
    repository: "openclaw/openclaw",
    status: "in_progress",
    url: "https://github.com/openclaw/openclaw/actions/runs/123",
    workflowName: "OpenClaw Release Publish",
    ...overrides,
  };
}

function writeClawHubApproval(overrides: Record<string, unknown> = {}) {
  const tempRoot = tempRoots.make("openclaw-clawhub-bootstrap-approval-");
  const approvalPath = path.join(tempRoot, "approval.json");
  writeJson(approvalPath, {
    version: 2,
    kind: "clawhub-bootstrap",
    repository: "openclaw/openclaw",
    workflow: "OpenClaw Release Publish",
    parentRunId: "123",
    parentRunAttempt: 2,
    workflowBranch: "main",
    parentWorkflowSha: "d".repeat(40),
    bootstrapWorkflowSha: "b".repeat(40),
    releaseTag: "v2026.7.1-beta.3",
    targetSha: "a".repeat(40),
    packages: ["@openclaw/meta-provider", "@openclaw/voice-call"],
    ...overrides,
  });
  return approvalPath;
}

function runClawHubApproval(
  env: Parameters<typeof runApprovalScript>[1] = {},
  approval: Record<string, unknown> = {},
) {
  return runApprovalScript(
    approvalRun({ headBranch: "main", headSha: "d".repeat(40), runAttempt: 2 }),
    {
      APPROVAL_PATH: writeClawHubApproval(approval),
      EXPECTED_WORKFLOW_BRANCH: "main",
      EXPECTED_RUN_ATTEMPT: "2",
      RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
      RELEASE_PACKAGES: "@openclaw/voice-call,@openclaw/meta-provider",
      RELEASE_TAG: "v2026.7.1-beta.3",
      ...env,
    },
  );
}

describe("scripts/validate-release-publish-approval.mjs", () => {
  it.each<[Fields, Partial<typeof approvalEnv>, number]>([
    [{ headBranch: "main" }, {}, 1],
    [{ conclusion: "success", status: "completed" }, {}, 1],
    [
      { conclusion: "failure", status: "completed" },
      { ALLOW_COMPLETED_SUCCESSFUL_PARENT: "true" },
      1,
    ],
    [
      { conclusion: "success", status: "completed" },
      { ALLOW_COMPLETED_SUCCESSFUL_PARENT: "true" },
      0,
    ],
  ])("validates parent %j with options %j", (run, env, status) => {
    const result = runApprovalScript(approvalRun(run), env);
    expect(result).toMatchObject({
      status,
      stdout: status
        ? ""
        : expect.stringContaining("https://github.com/openclaw/openclaw/actions/runs/123"),
      stderr: status ? expect.stringContaining("Referenced release publish run 123") : "",
    });
    if (status) {
      expect(result.stderr).toContain(
        run.headBranch ? "must have headBranch=" : "must still be in_progress",
      );
    }
  });

  androidIt.each([
    ["failed", FAILED_PARENT],
    ["rerun", { run_attempt: 3 }],
  ])("fences asset publication after the parent becomes %s", (_name, parent) => {
    for (const phase of ["afterAdmission", "afterFirstUpload"] as const) {
      const result = runAndroidApproval({ publication: { [phase]: parent } });
      expect(result.status).toBe(1);
      expect(result.uploads).toHaveLength(phase === "afterAdmission" ? 0 : 1);
    }
  });

  androidIt.each([
    ["failed", FAILED_PARENT],
    ["rerun", { run_attempt: 2 }],
  ])("fences asset publication after native qualification becomes %s", (_name, nativeCi) => {
    for (const phase of [
      "nativeCiAfterAdmission",
      "nativeCiAfterToolingRead",
      "nativeCiAfterFirstUpload",
    ] as const) {
      const result = runAndroidApproval({ nativeCi: {}, publication: { [phase]: nativeCi } });
      expect(result.status, result.stderr).toBe(1);
      expect(result.uploads).toHaveLength(phase === "nativeCiAfterFirstUpload" ? 1 : 0);
    }
  });

  androidIt.each<[string, Parameters<typeof runAndroidApproval>[0]]>([
    [
      "GitHub finalization with successful parent",
      {
        nativeCi: {},
        run: { status: "completed", conclusion: "success" },
        release: { isDraft: false },
        publication: {},
      },
    ],
    [
      "explicit failed-parent recovery",
      { recovery: true, publication: { afterAdmission: FAILED_PARENT } },
    ],
  ])("publishes both assets after %s", (_name, options) => {
    const result = runAndroidApproval(options);
    expect(result.status, result.stderr).toBe(0);
    expect(result.uploads).toEqual(ANDROID_ASSETS.map((name) => `dist/${name}#${name}`));
  });

  androidIt("rechecks failure parent authority immediately before provenance", () => {
    const workflow = parse(fs.readFileSync(".github/workflows/android-release.yml", "utf8"));
    const steps = workflow.jobs.publish_signed_android_apk.steps;
    const provenance = steps.findIndex(
      (step: { name: string }) => step.name === "Attest Android APK provenance",
    );
    expect(steps[provenance - 1]?.name).toBe(
      "Revalidate release approval before Android provenance",
    );
    rejectAndroid({
      publication: {
        beforeProvenance: true,
        afterAdmission: FAILED_PARENT,
      },
    });
  });

  androidIt("rejects an Android handoff whose attestation fails", () => {
    const result = runAndroidApproval({ attestationExitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Using attested Android");
  });

  androidIt.each<AndroidOptions & { diagnostic?: string }>([
    { publication: { afterToolingRead: FAILED_PARENT } },
    {
      nativeCi: {},
      publication: {
        nativeCiAfterAssetLookup: { run_attempt: 2, status: "queued", conclusion: null },
      },
    },
    {
      nativeCi: {},
      publication: {
        beforeProvenance: true,
        nativeCiAfterAdmission: { run_attempt: 2 },
      },
    },
    { nativeCi: { display_title: `CI release-native-android-123-2-${"b".repeat(40)}` } },
    { nativeCi: { actor: { login: "other" } } },
    { publication: { targetSha: "b".repeat(40) } },
    { publication: { release: { isPrerelease: true } } },
    { run: { head_sha: "e".repeat(40) }, diagnostic: "release publish parent run" },
    {
      identity: {
        ref: `refs/tags/${ANDROID_PROTECTED_REF}`,
        object: { type: "commit", sha: "e".repeat(40) },
      },
      diagnostic: "protected release tooling tag",
    },
    {
      ref: "main",
      identity: { status: "diverged" },
      diagnostic: "not reachable from current main",
    },
    {
      nativeCi: {},
      approval: {
        nativeCi: { runId: "91", runAttempt: 2, workflowRef: ANDROID_PROTECTED_REF },
      },
      diagnostic: "exact native CI qualification tuple",
    },
    {
      approval: { targetSha: "b".repeat(40) },
      diagnostic: "Attested Android release approval does not match",
    },
  ])("rejects unauthorized Android approval: %j", ({ diagnostic, ...options }) => {
    const result = rejectAndroid(options);
    if (diagnostic) {
      expect(result.stderr).toContain(diagnostic);
    }
  });

  androidIt("rejects cancelled parents even during explicit recovery", () => {
    const result = runAndroidApproval({
      recovery: true,
      run: { status: "completed", conclusion: "cancelled" },
    });
    expect(result.status, result.stderr).toBe(1);
  });

  it.each<[Partial<typeof approvalEnv>, Record<string, unknown>, unknown]>([
    [
      { APPROVAL_PATH: "" },
      {},
      expect.stringContaining("ClawHub bootstrap approval requires an attested approval artifact."),
    ],
    [
      {},
      { packages: ["@openclaw/meta-provider"] },
      expect.stringMatching(/Attested ClawHub bootstrap approval does not match|must use attempt/u),
    ],
  ])("rejects ClawHub bootstrap with env %j and artifact %j", (env, approval, message) => {
    const result = runClawHubApproval(env, approval);
    expect(result).toMatchObject({ status: 1, stderr: message });
  });
});

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
  approval?: Record<string, unknown>;
  run?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  recovery?: boolean;
  attestationExitCode?: number;
  release?: Record<string, unknown>;
  targetSha?: string;
  nativeCi?: Record<string, unknown>;
  publication?: {
    afterAdmission?: Record<string, unknown>;
    afterFirstUpload?: Record<string, unknown>;
    afterToolingRead?: Record<string, unknown>;
    nativeCiAfterAdmission?: Record<string, unknown>;
    nativeCiAfterAssetLookup?: Record<string, unknown>;
    nativeCiAfterFirstUpload?: Record<string, unknown>;
    nativeCiAfterToolingRead?: Record<string, unknown>;
    beforeProvenance?: boolean;
    targetSha?: string;
    release?: Record<string, unknown>;
  };
} = {}) {
  const tempRoot = tempRoots.make("openclaw-android-approval-");
  fs.mkdirSync(path.join(tempRoot, ".release-harness"));
  fs.symlinkSync(
    path.join(process.cwd(), "scripts"),
    path.join(tempRoot, ".release-harness/scripts"),
    "dir",
  );
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
  fs.writeFileSync(
    path.join(tempRoot, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const publication = ${JSON.stringify(publication ?? {})};
const publishing = fs.existsSync(${JSON.stringify(path.join(tempRoot, "publishing"))});
const parent = ${JSON.stringify(parent)}, nativeRun = ${JSON.stringify(nativeRun)};
function replace(file, base, phase) {
  if (publication[phase]) fs.writeFileSync(file, JSON.stringify({ ...base, ...publication[phase] }));
}
function output(text) { process.stdout.write(text); process.exit(0); }
if (args[0] === "attestation" && args[1] === "verify") {
  process.exit(${attestationExitCode});
}
if (args[0] === "release" && args[1] === "view") {
  if (args.includes("assets") && publishing) replace(${JSON.stringify(nativeCiPath)}, nativeRun, "nativeCiAfterAssetLookup");
  output(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(targetPath)}, "utf8")).release));
}
if (args[0] === "release" && args[1] === "upload") {
  const effects = JSON.parse(fs.readFileSync(${JSON.stringify(effectsPath)}, "utf8"));
  effects.push(args[3]);
  fs.writeFileSync(${JSON.stringify(effectsPath)}, JSON.stringify(effects));
  if (effects.length === 1) {
    replace(${JSON.stringify(parentPath)}, parent, "afterFirstUpload");
    replace(${JSON.stringify(nativeCiPath)}, nativeRun, "nativeCiAfterFirstUpload");
  }
  process.exit(0);
}
const runs = ${JSON.stringify({
      "repos/openclaw/openclaw/actions/runs/123": parentPath,
      "repos/openclaw/openclaw/actions/runs/91": nativeCiPath,
    })};
if (args[0] === "api" && runs[args[1]]) output(fs.readFileSync(runs[args[1]], "utf8"));
const responses = ${JSON.stringify({
      [`repos/openclaw/openclaw/${identityEndpoint}`]: tooling,
    })};
if (args[0] !== "api" || !responses[args[1]]) process.exit(91);
if (publishing) {
  replace(${JSON.stringify(parentPath)}, parent, "afterToolingRead");
  replace(${JSON.stringify(nativeCiPath)}, nativeRun, "nativeCiAfterToolingRead");
}
process.stdout.write(JSON.stringify(responses[args[1]]));
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
  const producer = runWorkflowStep(
    ".github/workflows/openclaw-release-publish.yml",
    "Write Android release approval",
    env,
    tempRoot,
  );
  expect(producer.status, producer.stderr).toBe(0);
  writeJson(approvalPath, { ...JSON.parse(fs.readFileSync(approvalPath, "utf8")), ...approval });
  writeJson(nativeCiPath, { ...nativeRun, ...nativeCi });
  let result = runWorkflowStep(
    ".github/workflows/android-release.yml",
    "Validate release approval and target",
    env,
  );
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
    fs.symlinkSync(path.join(process.cwd(), "scripts"), path.join(tempRoot, "scripts"), "dir");
    fs.mkdirSync(path.join(tempRoot, "dist"));
    for (const name of ANDROID_ASSETS) {
      fs.writeFileSync(path.join(tempRoot, "dist", name), "fixture");
    }
    result = runWorkflowStep(
      ".github/workflows/android-release.yml",
      publication.beforeProvenance
        ? "Revalidate release approval before Android provenance"
        : "Upload immutable Android release assets",
      env,
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
  it.each<[Record<string, unknown>, Partial<typeof approvalEnv>, string]>([
    [
      { headBranch: "main" },
      {},
      "Referenced release publish run 123 must have headBranch=release/2026.6.21, got main.",
    ],
    [
      { conclusion: "success", status: "completed" },
      {},
      "Referenced release publish run 123 must still be in_progress, got completed.",
    ],
    [
      { conclusion: "failure", status: "completed" },
      { ALLOW_COMPLETED_SUCCESSFUL_PARENT: "true" },
      "Referenced release publish run 123 must still be in_progress, got completed.",
    ],
  ])("rejects unauthorized parent %j with options %j", (run, env, message) => {
    const result = runApprovalScript(approvalRun(run), env);
    expect(result).toMatchObject({
      status: 1,
      stdout: "",
      stderr: expect.stringContaining(message),
    });
  });

  it("accepts a successful completed parent for detached publication", () => {
    const result = runApprovalScript(approvalRun({ conclusion: "success", status: "completed" }), {
      ALLOW_COMPLETED_SUCCESSFUL_PARENT: "true",
    });

    expect(result).toMatchObject({
      status: 0,
      stderr: "",
      stdout: expect.stringContaining(
        "Using successful completed release publish run 123: https://github.com/openclaw/openclaw/actions/runs/123",
      ),
    });
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

  androidIt.each<[string, Parameters<typeof runAndroidApproval>[0]]>([
    ["parent after live tooling reads", { publication: { afterToolingRead: FAILED_PARENT } }],
    [
      "native qualification after final asset lookup",
      {
        nativeCi: {},
        publication: {
          nativeCiAfterAssetLookup: { run_attempt: 2, status: "queued", conclusion: null },
        },
      },
    ],
    [
      "native qualification before provenance",
      {
        nativeCi: {},
        publication: { beforeProvenance: true, nativeCiAfterAdmission: { run_attempt: 2 } },
      },
    ],
  ])("rechecks %s", (_name, options) => {
    rejectAndroid(options);
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

  androidIt.each([
    ["source", { display_title: `CI release-native-android-123-2-${"b".repeat(40)}` }],
    ["actor", { actor: { login: "other" } }],
  ])("rejects another native qualification %s", (_name, nativeCi) => {
    rejectAndroid({ nativeCi });
  });

  androidIt("rechecks failure parent authority immediately before provenance", () => {
    const workflow = parse(fs.readFileSync(".github/workflows/android-release.yml", "utf8"));
    const steps = workflow.jobs.publish_signed_android_apk.steps;
    const provenanceIndex = steps.findIndex(
      (step: { name: string }) => step.name === "Attest Android APK provenance",
    );
    expect(steps[provenanceIndex - 1].name).toBe(
      "Revalidate release approval before Android provenance",
    );
    rejectAndroid({
      publication: {
        beforeProvenance: true,
        afterAdmission: FAILED_PARENT,
      },
    });
  });

  androidIt.each([
    ["moved target", { targetSha: "b".repeat(40) }],
    ["prerelease target", { release: { isPrerelease: true } }],
  ])("fences asset publication after the release becomes a %s", (_name, publication) => {
    rejectAndroid({ publication });
  });

  androidIt("rejects an Android handoff whose attestation fails", () => {
    const result = runAndroidApproval({ attestationExitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Using attested Android");
  });

  androidIt.each<[string, Parameters<typeof runAndroidApproval>[0], string]>([
    [
      "different live parent SHA",
      { run: { head_sha: "e".repeat(40) } },
      "release publish parent run",
    ],
    [
      "moved tooling tag",
      {
        identity: {
          ref: `refs/tags/${ANDROID_PROTECTED_REF}`,
          object: { type: "commit", sha: "e".repeat(40) },
        },
      },
      "protected release tooling tag",
    ],
    [
      "parent unreachable from main",
      { ref: "main", identity: { status: "diverged" } },
      "not reachable from current main",
    ],
    [
      "malformed attested native tuple",
      {
        nativeCi: {},
        approval: {
          nativeCi: { runId: "91", runAttempt: 2, workflowRef: ANDROID_PROTECTED_REF },
        },
      },
      "exact native CI qualification tuple",
    ],
    [
      "different attested target SHA",
      { approval: { targetSha: "b".repeat(40) } },
      "Attested Android release approval does not match this run request.",
    ],
  ])("rejects Android approval with %s", (_name, options, message) => {
    expect(rejectAndroid(options).stderr).toContain(message);
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

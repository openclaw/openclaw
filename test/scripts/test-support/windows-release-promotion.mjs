import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const SCRIPT = resolve("scripts/windows-release-promotion.mjs");
const SHA = "d".repeat(40);
const REF = "release-publish/" + SHA.slice(0, 12) + "-123";
const TAG = "v2026.9.1";
const REPOSITORY = "openclaw/openclaw";
const NAMES = ["OpenClawCompanion-Setup-arm64.exe", "OpenClawCompanion-Setup-x64.exe"];

export const windowsPromotionCases = [
  ["final tag on npm beta", "npm-beta", 3, ""],
  ["failed parent", "failed", 0, "state is not allowed by active-or-success"],
  ["explicit failed-parent recovery", "recovery", 3, ""],
  ["failed attestation", "attestation", 0, "attestation verify"],
  [
    "signed object replaced after validation",
    "wait-tag-object",
    0,
    "tag moved, disappeared, or changed",
  ],
  ["changed approved source", "source", 0, "approval source or fields"],
  ["changed original publisher", "tuple", 0, "approval parentRunId mismatch"],
  ["executing workflow SHA differs", "workflow-sha", 0, "approval toolingSha mismatch"],
  [
    "candidate movement after first upload",
    "after-upload-tag",
    1,
    "tag moved, disappeared, or changed",
  ],
  [
    "tooling movement after first upload",
    "after-upload-tooling",
    1,
    "protected release tooling tag is missing, moved",
  ],
  ["parent rerun after first upload", "after-upload-parent", 1, "parent run runAttempt"],
  [
    "writer cancelled after first upload",
    "after-upload-writer",
    1,
    "protected Windows writer is not active",
  ],
  ["attach Windows after core publication", "late-attachment", 3, ""],
  ["late attachment requires explicit recovery", "late-automatic", 0, "approval source or fields"],
  ["superseded writer attempt", "child-attempt", 0, "release workflow run runAttempt"],
  ["writer awaiting admission", "writer-waiting", 0, "protected Windows writer is not active"],
  [
    "late attachment validates selected digests",
    "late-invalid",
    0,
    "exactly the two pinned installer digests",
  ],
];

export function runWindowsPromotionCase([label, scenario, expectedUploads, refusal]) {
  const root = mkdtempSync(join(tmpdir(), "windows-promotion-proof-"));
  try {
    const assets = join(root, "dist");
    const bin = join(root, "bin");
    mkdirSync(assets);
    mkdirSync(bin);
    const command = (program, args, options = {}) => {
      const result = spawnSync(program, args, { cwd: root, encoding: "utf8", ...options });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const git = (...args) => command("git", args);
    git("init", "--bare", "--quiet", join(root, "remote.git"));
    git("init", "--quiet", join(root, "checkout"));
    const cwd = join(root, "checkout");
    const author = {
      ...process.env,
      GIT_AUTHOR_NAME: "Release Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Release Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    };
    const tree = command("git", ["--git-dir", join(root, "remote.git"), "mktree"], { input: "" });
    const target = command("git", ["--git-dir", join(root, "remote.git"), "commit-tree", tree], {
      input: "candidate\n",
      env: author,
    });
    const other = command("git", ["--git-dir", join(root, "remote.git"), "commit-tree", tree], {
      input: "other candidate\n",
      env: author,
    });
    const tagObject = (message) =>
      command("git", ["--git-dir", join(root, "remote.git"), "mktag"], {
        input: `object ${target}\ntype commit\ntag ${TAG}\ntagger Release Fixture <fixture@example.com> 1 +0000\n\n${message}\n`,
      });
    const approvedTag = tagObject("approved object");
    git("--git-dir", join(root, "remote.git"), "update-ref", "refs/tags/" + TAG, approvedTag);
    command("git", ["remote", "add", "origin", join(root, "remote.git")], { cwd });
    const digests = Object.fromEntries(NAMES.map((name) => [name, "sha256:" + "a".repeat(64)]));
    const receipt = {
      version: 1,
      kind: "openclaw-release-approval",
      repository: REPOSITORY,
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      parentRunId: "123",
      parentRunAttempt: "1",
      toolingRef: REF,
      toolingFullRef: "refs/tags/" + REF,
      toolingSha: SHA,
      releaseTag: TAG,
      targetSha: target,
      npmDistTag: scenario === "npm-beta" ? "beta" : "latest",
      environment: "npm-release",
      approvalJob: "Publish plugins, then OpenClaw",
      approver: "release-maintainer",
    };
    const receiptPath = join(root, "receipt.json");
    const approvalPath = join(root, "approval.json");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const statePath = join(root, "state.json");
    const state = { scenario, uploads: [], remote: join(root, "remote.git"), other };
    writeFileSync(statePath, JSON.stringify(state));
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      "#!" +
        process.execPath +
        "\n" +
        String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.PROOF_STATE, "utf8"));
const scenario = state.scenario;
const sha = "d".repeat(40);
const ref = "release-publish/" + sha.slice(0, 12) + "-123";
const changed = state.uploads.length > 0;
let output;
if (args[0] === "attestation") {
  if (scenario === "attestation") process.exit(1);
  output = {};
} else if (args[0] === "release" && args[1] === "view") {
  output = { tagName: "v2026.9.1", isPrerelease: false };
} else if (args[0] === "release" && args[1] === "upload") {
  state.uploads.push(require("node:path").basename(args[3]));
  if (scenario === "after-upload-tag") cp.execFileSync("git", ["--git-dir", state.remote, "update-ref", "refs/tags/v2026.9.1", state.other]);
  fs.writeFileSync(process.env.PROOF_STATE, JSON.stringify(state));
  output = {};
} else if (args[0] === "api" && args[1].includes("/git/ref/tags/")) {
  output = { ref: "refs/tags/" + ref, object: { type: "commit", sha: changed && scenario === "after-upload-tooling" ? "e".repeat(40) : sha } };
} else if (args[0] === "api" && args[1].includes("/attempts/1/jobs")) {
  const rejected = changed && scenario === "after-upload-writer";
  const writer = {
    name: "Promote signed Windows installers", run_id: 456,
    head_sha: sha,
    status: rejected ? "completed" : scenario === "writer-waiting" ? "waiting" : "in_progress",
    conclusion: rejected ? "cancelled" : null,
  };
  const jobs = [writer];
  output = { total_count: jobs.length, jobs };
} else if (args[0] === "api" && /actions\/runs\/(123|456)$/.test(args[1])) {
  const parent = args[1].endsWith("/123");
  const failed = parent && ["failed", "recovery"].includes(scenario);
  output = {
    id: parent ? 123 : 456, run_attempt: (parent ? changed && scenario === "after-upload-parent" : scenario === "child-attempt") ? 2 : 1,
    head_branch: ref, head_sha: sha, repository: { full_name: "openclaw/openclaw" },
    event: "workflow_dispatch", path: ".github/workflows/" + (parent ? "openclaw-release-publish.yml" : "windows-node-release.yml") + "@refs/tags/" + ref,
    status: parent ? "completed" : "in_progress",
    conclusion: parent ? (failed ? "failure" : "success") : null,
  };
} else {
  throw new Error("Unexpected GitHub fixture request: " + JSON.stringify(args));
}
process.stdout.write(JSON.stringify(output));
`,
    );
    chmodSync(ghPath, 0o755);
    const env = {
      ...process.env,
      ...author,
      PATH: bin + delimiter + process.env.PATH,
      PROOF_STATE: statePath,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_WORKFLOW_REF:
        REPOSITORY + "/.github/workflows/windows-node-release.yml@refs/tags/" + REF,
      GITHUB_REF: "refs/tags/" + REF,
      GITHUB_REF_NAME: REF,
      GITHUB_WORKFLOW_SHA: SHA,
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      RELEASE_PUBLISH_RUN_ID: "123",
      RELEASE_PUBLISH_RUN_ATTEMPT: "1",
      RELEASE_TAG: TAG,
      SIGNED_RELEASE_TAG_OBJECT_SHA: approvedTag,
      WINDOWS_NODE_TAG: "v0.6.3",
      WINDOWS_NODE_INSTALLER_DIGESTS: JSON.stringify(digests),
      DIRECT_RELEASE_RECOVERY: ["recovery", "late-attachment", "late-invalid"].includes(scenario)
        ? "true"
        : "false",
    };
    command(
      process.execPath,
      [SCRIPT, "create", "--receipt", receiptPath, "--output", approvalPath],
      {
        env: scenario.startsWith("late-")
          ? { ...env, WINDOWS_NODE_TAG: "", WINDOWS_NODE_INSTALLER_DIGESTS: "" }
          : env,
        cwd,
      },
    );
    if (scenario.startsWith("late-")) {
      assert.equal(JSON.parse(readFileSync(approvalPath, "utf8")).source, null);
    }
    if (scenario === "wait-tag-object") {
      command(process.execPath, [SCRIPT, "verify", "--approval", approvalPath], { env, cwd });
      git(
        "--git-dir",
        state.remote,
        "update-ref",
        "refs/tags/" + TAG,
        tagObject("replacement object"),
      );
    }
    if (scenario === "late-invalid") {
      env.WINDOWS_NODE_INSTALLER_DIGESTS = "{}";
    }
    if (scenario === "source") {
      env.WINDOWS_NODE_TAG = "v0.6.4";
    }
    if (scenario === "workflow-sha") {
      env.GITHUB_WORKFLOW_SHA = "e".repeat(40);
    }
    if (scenario === "tuple") {
      env.RELEASE_PUBLISH_RUN_ID = "124";
    }
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "publish", "--approval", approvalPath, "--assets", assets],
      { env, cwd, encoding: "utf8" },
    );
    const uploads = JSON.parse(readFileSync(statePath, "utf8")).uploads;
    assert.equal(result.status, expectedUploads === 3 ? 0 : 1, label + ": " + result.stderr);
    assert.deepEqual(
      uploads,
      [...NAMES, "OpenClawCompanion-SHA256SUMS.txt"].slice(0, expectedUploads),
      label,
    );
    if (refusal) {
      assert.ok(result.stderr.includes(refusal), label + ": wrong refusal: " + result.stderr);
    }
    return label;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

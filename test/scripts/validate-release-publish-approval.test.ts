// Validate release publish approval tests cover the stdin/env CLI contract.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/validate-release-publish-approval.mjs";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function runApprovalScript(
  run: Record<string, unknown>,
  env: {
    DIRECT_RELEASE_RECOVERY?: string;
    EXPECTED_WORKFLOW_BRANCH?: string;
    APPROVAL_PATH?: string;
    GITHUB_REPOSITORY?: string;
    RELEASE_TAG?: string;
    RELEASE_PUBLISH_RUN_ID?: string;
    RELEASE_TARGET_SHA?: string;
  } = {},
) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DIRECT_RELEASE_RECOVERY: env.DIRECT_RELEASE_RECOVERY ?? "false",
      EXPECTED_WORKFLOW_BRANCH: env.EXPECTED_WORKFLOW_BRANCH ?? "release/2026.6.21",
      APPROVAL_PATH: env.APPROVAL_PATH ?? "",
      GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? "openclaw/openclaw",
      RELEASE_TAG: env.RELEASE_TAG ?? "v2026.6.21",
      RELEASE_PUBLISH_RUN_ID: env.RELEASE_PUBLISH_RUN_ID ?? "123",
      RELEASE_TARGET_SHA: env.RELEASE_TARGET_SHA ?? "a".repeat(40),
    },
    input: JSON.stringify(run),
  });
}

function writeApproval(overrides: Record<string, unknown> = {}) {
  const tempRoot = tempRoots.make("openclaw-release-approval-");
  const approvalPath = path.join(tempRoot, "approval.json");
  fs.writeFileSync(
    approvalPath,
    `${JSON.stringify({
      version: 1,
      repository: "openclaw/openclaw",
      workflow: "OpenClaw Release Publish",
      parentRunId: "123",
      workflowBranch: "release/2026.6.21",
      releaseTag: "v2026.6.21",
      targetSha: "a".repeat(40),
      ...overrides,
    })}\n`,
  );
  return approvalPath;
}

function approvalRun(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: null,
    event: "workflow_dispatch",
    headBranch: "release/2026.6.21",
    status: "in_progress",
    url: "https://github.com/openclaw/openclaw/actions/runs/123",
    workflowName: "OpenClaw Release Publish",
    ...overrides,
  };
}

describe("scripts/validate-release-publish-approval.mjs", () => {
  it("accepts an in-progress release publish workflow run for approval", () => {
    const result = runApprovalScript(approvalRun());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using release publish approval run 123: https://github.com/openclaw/openclaw/actions/runs/123",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects approval runs from the wrong workflow branch", () => {
    const result = runApprovalScript(approvalRun({ headBranch: "main" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Referenced release publish run 123 must have headBranch=release/2026.6.21, got main.",
    );
    expect(result.stdout).toBe("");
  });

  it("rejects completed runs for normal approval handoff", () => {
    const result = runApprovalScript(approvalRun({ conclusion: "success", status: "completed" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Referenced release publish run 123 must still be in_progress, got completed.",
    );
    expect(result.stdout).toBe("");
  });

  it("accepts an exact attested Android release approval", () => {
    const approvalPath = writeApproval();

    const result = runApprovalScript(approvalRun(), { APPROVAL_PATH: approvalPath });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["parent run", { parentRunId: "999" }],
    ["release tag", { releaseTag: "v2026.6.22" }],
    ["target SHA", { targetSha: "b".repeat(40) }],
    ["extra field", { unexpected: true }],
  ])("rejects an attested Android approval for another %s", (_name, overrides) => {
    const approvalPath = writeApproval(overrides);

    const result = runApprovalScript(approvalRun(), { APPROVAL_PATH: approvalPath });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Attested Android release approval does not match this run request.",
    );
  });

  it("accepts completed success or failure runs for direct recovery", () => {
    for (const conclusion of ["success", "failure"]) {
      const result = runApprovalScript(approvalRun({ conclusion, status: "completed" }), {
        DIRECT_RELEASE_RECOVERY: "true",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `Using completed release publish run 123 (${conclusion}) for direct recovery: https://github.com/openclaw/openclaw/actions/runs/123`,
      );
      expect(result.stderr).toBe("");
    }
  });
});

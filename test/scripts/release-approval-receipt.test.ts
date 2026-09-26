import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitParentAuthorization,
  createReleaseApprovalReceipt,
  downloadReleaseApprovalReceipt,
  releaseApprovalArtifactName,
  validateReleaseApprovalReceipt,
  verifyReleaseApprovalReceipt,
} from "../../scripts/release-approval-receipt.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const targetSha = "b".repeat(40);
const repository = "openclaw/openclaw";
const workflow = ".github/workflows/openclaw-release-publish.yml";
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: "10",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_REF_NAME: "main",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
  RELEASE_TAG: "v2026.9.24-beta.1",
  TARGET_SHA: targetSha,
  RELEASE_NPM_DIST_TAG: "beta",
};

function approved(login = "octocat") {
  return { state: "approved", environments: [{ name: "npm-release" }], user: { login } };
}

function fixture() {
  const receipt = {
    version: 1,
    kind: "openclaw-release-approval",
    repository,
    parentWorkflow: workflow,
    parentRunId: "10",
    parentRunAttempt: "2",
    toolingRef: "main",
    toolingFullRef: "refs/heads/main",
    toolingSha: sha,
    releaseTag: "v2026.9.24-beta.1",
    targetSha,
    npmDistTag: "beta",
    environment: "npm-release",
    approvalJob: "Publish plugins, then OpenClaw",
    approver: "octocat",
  };
  return {
    receipt,
    expected: {
      repository,
      parentRunId: "10",
      parentRunAttempt: "2",
      toolingRef: "main",
      toolingFullRef: "refs/heads/main",
      toolingSha: sha,
      releaseTag: "v2026.9.24-beta.1",
      targetSha,
      npmDistTag: "beta",
    },
    artifact: {
      id: 50,
      name: "openclaw-release-approval-v1-10-2",
      expired: false,
      workflow_run: { id: 10, head_sha: sha, repository_id: 99, head_repository_id: 99 },
    },
    parentRun: {
      id: 10,
      run_attempt: 2,
      event: "workflow_dispatch",
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      head_branch: "main",
      head_sha: sha,
      path: workflow,
      status: "in_progress",
      conclusion: null as string | null,
    },
    parentJobs: {
      total_count: 1,
      jobs: [
        {
          name: "Publish plugins, then OpenClaw",
          head_sha: sha,
          run_id: 10,
          run_attempt: 2,
          status: "in_progress",
          steps: [
            { name: "Write release approval receipt", status: "completed", conclusion: "success" },
          ],
        },
      ],
    },
    approvals: [approved()],
  };
}

describe("release approval receipt", () => {
  it("creates the exact receipt using the last approved npm-release reviewer", () => {
    const receipt = createReleaseApprovalReceipt(env, (path: string) => {
      expect(path).toBe("actions/runs/10/approvals");
      return [
        approved("earlier-reviewer"),
        approved(),
        { ...approved("rejected-reviewer"), state: "rejected" },
        { ...approved("other-reviewer"), environments: [{ name: "other-environment" }] },
      ];
    });
    expect(receipt).toEqual(fixture().receipt);
    expect(Object.keys(receipt)).toEqual(Object.keys(fixture().receipt));
    expect(releaseApprovalArtifactName({ parentRunId: "10", parentRunAttempt: "2" })).toBe(
      "openclaw-release-approval-v1-10-2",
    );
    expect(validateReleaseApprovalReceipt(receipt)).toBe(receipt);
  });

  it.each(["github-actions[bot]", "reviewer[BoT]", "", " "])(
    "rejects an invalid last approver %j",
    (login) => {
      expect(() => createReleaseApprovalReceipt(env, () => [approved(), approved(login)])).toThrow(
        /human login/u,
      );
    },
  );

  it("rejects approval histories without an approved npm-release entry", () => {
    expect(() =>
      createReleaseApprovalReceipt(env, () => [
        { ...approved(), state: "rejected" },
        { ...approved(), environments: [{ name: "clawhub-plugin-release" }] },
      ]),
    ).toThrow(/approved npm-release environment/u);
  });

  it.each([
    ["GITHUB_EVENT_NAME", "push", /workflow_dispatch/u],
    ["GITHUB_WORKFLOW_REF", `${repository}/${workflow}@refs/heads/other`, /workflow ref/u],
    ["GITHUB_REPOSITORY", "other/repository", /repository mismatch/u],
  ] as const)("rejects creation with wrong %s", (key, value, message) => {
    expect(() =>
      createReleaseApprovalReceipt({ ...env, [key]: value }, () => [approved()]),
    ).toThrow(message);
  });

  it("accepts exact protected tooling tags and rejects branch aliases or mismatched SHA prefixes", () => {
    const ref = "release-publish/aaaaaaaaaaaa-42";
    const receipt = { ...fixture().receipt, toolingRef: ref, toolingFullRef: `refs/tags/${ref}` };
    expect(validateReleaseApprovalReceipt(receipt)).toBe(receipt);
    for (const patch of [{ toolingFullRef: `refs/heads/${ref}` }, { toolingSha: "c".repeat(40) }]) {
      expect(() => validateReleaseApprovalReceipt({ ...receipt, ...patch })).toThrow(/protected/u);
    }
  });

  it.each([
    ["parentRunId", "01", /parentRunId/u],
    ["parentRunAttempt", "0", /parentRunAttempt/u],
    ["releaseTag", "v2026.09.24", /Release tag/u],
    ["targetSha", "invalid", /Target SHA/u],
    ["npmDistTag", "default", /dist-tag/u],
    ["approver", "x".repeat(8 * 1024), /8 KiB/u],
  ] as const)("rejects malformed or oversized %s", (key, value, message) => {
    expect(() => validateReleaseApprovalReceipt({ ...fixture().receipt, [key]: value })).toThrow(
      message,
    );
  });

  it("verifies approval while the parent publish job is still running", () => {
    const input = fixture();
    expect(verifyReleaseApprovalReceipt(input)).toBe(input.receipt);
  });

  it("rejects extra receipt keys", () => {
    const input = fixture();
    expect(() =>
      verifyReleaseApprovalReceipt({ ...input, receipt: { ...input.receipt, extra: true } }),
    ).toThrow(/fields/u);
  });

  it.each([
    ["parentRunId", "11"],
    ["parentRunAttempt", "3"],
    ["toolingSha", "c".repeat(40)],
    ["releaseTag", "v2026.9.25-beta.1"],
    ["targetSha", "d".repeat(40)],
    ["npmDistTag", "latest"],
  ] as const)("rejects a different expected %s", (key, value) => {
    const input = fixture();
    expect(() =>
      verifyReleaseApprovalReceipt({ ...input, expected: { ...input.expected, [key]: value } }),
    ).toThrow(new RegExp(`${key} does not match`, "u"));
  });

  it("rejects a tampered approver absent from approval history", () => {
    const input = fixture();
    input.receipt.approver = "someone-else";
    expect(() => verifyReleaseApprovalReceipt(input)).toThrow(/approver is not in/u);
  });

  it.each([
    [
      "another run",
      (input: ReturnType<typeof fixture>) => {
        input.artifact.workflow_run.id = 11;
      },
      /artifact parent run/u,
    ],
    [
      "expired artifact",
      (input: ReturnType<typeof fixture>) => {
        input.artifact.expired = true;
      },
      /expired/u,
    ],
    [
      "fork artifact",
      (input: ReturnType<typeof fixture>) => {
        input.artifact.workflow_run.head_repository_id = 100;
      },
      /artifact repository/u,
    ],
    [
      "unsuccessful receipt step",
      (input: ReturnType<typeof fixture>) => {
        expectDefined(expectDefined(input.parentJobs.jobs[0], "job").steps[0], "step").conclusion =
          "failure";
      },
      /receipt step/u,
    ],
    [
      "missing parent job",
      (input: ReturnType<typeof fixture>) => {
        input.parentJobs = { total_count: 0, jobs: [] };
      },
      /parent job must be unique/u,
    ],
    [
      "duplicate parent job",
      (input: ReturnType<typeof fixture>) => {
        input.parentJobs.jobs.push(expectDefined(input.parentJobs.jobs[0], "job"));
        input.parentJobs.total_count = 2;
      },
      /parent job must be unique/u,
    ],
    [
      "wrong job attempt",
      (input: ReturnType<typeof fixture>) => {
        expectDefined(input.parentJobs.jobs[0], "job").run_attempt = 1;
      },
      /job identity/u,
    ],
  ] as const)("rejects %s", (_name, change, message) => {
    const input = fixture();
    change(input);
    expect(() => verifyReleaseApprovalReceipt(input)).toThrow(message);
  });

  it("rejects completed parents under active and permits only successful detached parents", () => {
    const input = fixture();
    input.parentRun.status = "completed";
    input.parentRun.conclusion = "failure";
    expect(() => verifyReleaseApprovalReceipt(input)).toThrow(/not allowed by active/u);
    const detached = {
      ...input,
      expected: { ...input.expected, parentStatePolicy: "active-or-success" },
    };
    expect(() => verifyReleaseApprovalReceipt(detached)).toThrow(
      /not allowed by active-or-success/u,
    );
    input.parentRun.conclusion = "success";
    expect(() => verifyReleaseApprovalReceipt(input)).toThrow(/not allowed by active/u);
    expect(verifyReleaseApprovalReceipt(detached)).toBe(input.receipt);
  });

  it("creates the receipt and artifact output through the CLI without overwriting files", () => {
    const directory = tempDirs.make("release-approval-cli-");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["api", "repos/openclaw/openclaw/actions/runs/10/approvals", "--method", "GET"])) process.exit(1);
console.log(${JSON.stringify(JSON.stringify([approved()]))});
`,
      { mode: 0o755 },
    );
    const output = join(directory, "receipt", "approval.json");
    const githubOutput = join(directory, "output");
    const args = [resolve("scripts/release-approval-receipt.mjs"), "create", "--output", output];
    const options = {
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: githubOutput },
    } as const;
    const result = spawnSync(process.execPath, args, options);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`${JSON.stringify(fixture().receipt)}\n`);
    expect(readFileSync(githubOutput, "utf8")).toBe(
      "artifact_name=openclaw-release-approval-v1-10-2\n",
    );
    const second = spawnSync(process.execPath, args, options);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("EEXIST");
    expect(readFileSync(githubOutput, "utf8")).toBe(
      "artifact_name=openclaw-release-approval-v1-10-2\n",
    );
  });
});

describe("release approval artifact download", () => {
  it("downloads the digest-bound archive and verifies fresh parent metadata", async () => {
    const input = fixture();
    const archive = await new JSZip()
      .file("approval.json", `${JSON.stringify(input.receipt, null, 2)}\n`)
      .generateAsync({ type: "nodebuffer" });
    const artifact = {
      ...input.artifact,
      size_in_bytes: archive.length,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      expires_at: "2026-10-24T00:00:00Z",
    };
    const apiResponses: Record<string, unknown> = {
      "actions/runs/10/artifacts?name=openclaw-release-approval-v1-10-2&per_page=100": {
        total_count: 1,
        artifacts: [artifact],
      },
      "actions/runs/10/attempts/2": input.parentRun,
      "actions/runs/10/attempts/2/jobs?per_page=100": input.parentJobs,
      "actions/runs/10/approvals": input.approvals,
    };
    const result = await downloadReleaseApprovalReceipt({
      expected: input.expected,
      token: "synthetic-token",
      runGhJson: (path: string) => {
        expect(apiResponses).toHaveProperty(path);
        return apiResponses[path];
      },
      fetchImpl: async (url: string) => {
        if (url === "https://api.github.com/repos/openclaw/openclaw/actions/artifacts/50") {
          return Response.json(artifact);
        }
        expect(url).toBe("https://api.github.com/repos/openclaw/openclaw/actions/artifacts/50/zip");
        return new Response(new Uint8Array(archive));
      },
    });
    expect(result).toEqual({ receipt: input.receipt, artifact });
  });

  it.each([0, 2])(
    "rejects %i matching artifacts when the parent cannot supply a receipt",
    async (count) => {
      const input = fixture();
      await expect(
        downloadReleaseApprovalReceipt({
          expected: input.expected,
          token: "synthetic-token",
          runGhJson: (path: string) =>
            path.endsWith("/attempts/2")
              ? { ...input.parentRun, status: "completed", conclusion: "failure" }
              : {
                  total_count: count,
                  artifacts: Array.from({ length: count }, () => input.artifact),
                },
          fetchImpl: async () => {
            throw new Error("unexpected download");
          },
        }),
      ).rejects.toThrow(
        /artifact is missing or ambiguous|artifact is missing; parent is inactive/u,
      );
    },
  );
});

describe.each([
  ["ClawHub", "openclaw-clawhub-parent-authorization-v2-10-2-30-1", false],
  ["npm", "openclaw-release-approval-v1-10-2", true],
])("%s parent authorization wait", (_target, name, requireInProgress) => {
  const listing = `actions/runs/10/artifacts?name=${name}&per_page=100`;
  const authorization = {
    name,
    expired: false,
    workflow_run: { id: 10, head_sha: "a".repeat(40) },
  };
  const params = {
    parentRunId: "10",
    parentRunAttempt: "2",
    expectedArtifactName: name,
    requireInProgress,
    toolingSha: "a".repeat(40),
    sleep: async () => {},
  };
  function api(
    artifacts: unknown[][],
    parent: { status: string; conclusion: string | null } = {
      status: "in_progress",
      conclusion: null,
    },
  ) {
    let polls = 0;
    return (path: string) => {
      if (path === listing) {
        const page = artifacts[Math.min(polls++, artifacts.length - 1)] ?? [];
        return { total_count: page.length, artifacts: page };
      }
      expect(path).toBe("actions/runs/10/attempts/2");
      return parent;
    };
  }

  it("blocks until the expected authorization appears, then proceeds", async () => {
    const runGhJson = api([[], [], [authorization]]);
    await expect(awaitParentAuthorization({ ...params, runGhJson })).resolves.toEqual(
      authorization,
    );
  });

  it.each(["success", "cancelled", "failure"])(
    "requires a live npm parent even when its artifact exists (%s)",
    async (conclusion) => {
      const runGhJson = api([[authorization]], { status: "completed", conclusion });
      const result = awaitParentAuthorization({ ...params, runGhJson });
      if (requireInProgress) {
        await expect(result).rejects.toThrow(/completed\//u);
      } else {
        await expect(result).resolves.toEqual(authorization);
      }
    },
  );

  it("fails when the parent leaves in_progress without authorizing", async () => {
    const runGhJson = api([[]], { status: "completed", conclusion: "failure" });
    await expect(awaitParentAuthorization({ ...params, runGhJson })).rejects.toThrow(
      /completed\/failure without authorizing/u,
    );
  });

  it("fails at the deadline while the parent is still running", async () => {
    const runGhJson = api([[]]);
    await expect(awaitParentAuthorization({ ...params, runGhJson, deadlineMs: 0 })).rejects.toThrow(
      /did not appear before the deadline/u,
    );
  });

  it.each([
    ["another parent", { ...authorization, workflow_run: { id: 11, head_sha: "a".repeat(40) } }],
    ["other tooling", { ...authorization, workflow_run: { id: 10, head_sha: "b".repeat(40) } }],
    ["expired", { ...authorization, expired: true }],
  ])("rejects an authorization from %s", async (_label, artifact) => {
    const runGhJson = api([[artifact]]);
    await expect(awaitParentAuthorization({ ...params, runGhJson })).rejects.toThrow(
      /does not belong to the parent/u,
    );
  });

  it("rejects an ambiguous authorization listing", async () => {
    const runGhJson = api([[authorization, authorization]]);
    await expect(awaitParentAuthorization({ ...params, runGhJson })).rejects.toThrow(/ambiguous/u);
  });
});

describe("parent authorization CLI", () => {
  it.each([
    ["wait-npm-authorization", "in_progress", null, 0, "openclaw-release-approval-v1-10-2"],
    ["wait-npm-authorization", "completed", "success", 1, "openclaw-release-approval-v1-10-2"],
    ["wait-npm-authorization", "completed", "cancelled", 1, "openclaw-release-approval-v1-10-2"],
    [
      "wait-clawhub-authorization",
      "completed",
      "success",
      0,
      "openclaw-clawhub-parent-authorization-v2-10-2-30-1",
    ],
  ] as const)(
    "%s checks its exact artifact with parent %s/%s",
    (command, status, conclusion, exitCode, name) => {
      const directory = tempDirs.make("parent-authorization-cli-");
      const artifact = { ...fixture().artifact, name };
      const responses = {
        [`repos/openclaw/openclaw/actions/runs/10/artifacts?name=${name}&per_page=100`]: {
          total_count: 1,
          artifacts: [artifact],
        },
        "repos/openclaw/openclaw/actions/runs/10/attempts/2": { status, conclusion },
      };
      writeFileSync(
        join(directory, "gh"),
        `#!${process.execPath}
const responses = ${JSON.stringify(responses)};
const response = responses[process.argv[3]];
if (!response) process.exit(2);
console.log(JSON.stringify(response));
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/release-approval-receipt.mjs"), command],
        {
          encoding: "utf8",
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            RELEASE_PUBLISH_RUN_ID: "10",
            RELEASE_PUBLISH_RUN_ATTEMPT: "2",
            EXPECTED_WORKFLOW_SHA: sha,
            GITHUB_RUN_ID: "30",
            GITHUB_RUN_ATTEMPT: "1",
          },
        },
      );
      expect(result.status, result.stderr).toBe(exitCode);
      if (exitCode === 0) {
        expect(result.stdout).toContain(name);
      } else {
        expect(result.stderr).toContain(`completed/${conclusion} without authorizing`);
      }
    },
  );
});

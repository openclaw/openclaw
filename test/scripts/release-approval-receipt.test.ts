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
  validateReleaseApprovalReceipt,
  verifyReleaseApprovalReceipt,
} from "../../scripts/release-approval-receipt.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const targetSha = "b".repeat(40);
const repository = "openclaw/openclaw";
const workflow = ".github/workflows/openclaw-release-publish.yml";
const artifactName = "openclaw-release-approval-v1-10-2";
const approvalJob = "Publish plugins, then OpenClaw";
const receiptStep = "Write release approval receipt";
const releaseTag = "v2026.9.24-beta.1";
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: "10",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_REF_NAME: "main",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
  RELEASE_TAG: releaseTag,
  TARGET_SHA: targetSha,
  RELEASE_NPM_DIST_TAG: "beta",
};

function approved(login = "octocat") {
  return { state: "approved", environments: [{ name: "npm-release" }], user: { login } };
}

function fixture() {
  const identity = {
    parentRunId: "10",
    parentRunAttempt: "2",
    toolingRef: "main",
    toolingFullRef: "refs/heads/main",
    toolingSha: sha,
    releaseTag,
    targetSha,
    npmDistTag: "beta",
  };
  const receipt = {
    version: 1,
    kind: "openclaw-release-approval",
    repository,
    parentWorkflow: workflow,
    ...identity,
    environment: "npm-release",
    approvalJob,
    approver: "octocat",
  };
  return {
    receipt,
    expected: { repository, ...identity },
    artifact: {
      id: 50,
      name: artifactName,
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
          name: approvalJob,
          head_sha: sha,
          run_id: 10,
          run_attempt: 2,
          status: "in_progress",
          steps: [{ name: receiptStep, status: "completed", conclusion: "success" }],
        },
      ],
    },
    approvals: [approved()],
  };
}

describe("release approval receipt", () => {
  it.each<[string, Partial<typeof env>, ReturnType<typeof approved>[], RegExp | undefined]>([
    [
      "last approved npm-release reviewer",
      {},
      [
        approved("earlier-reviewer"),
        approved(),
        { ...approved("rejected-reviewer"), state: "rejected" },
        { ...approved("other-reviewer"), environments: [{ name: "other-environment" }] },
      ],
      undefined,
    ],
    ["bot reviewer", {}, [approved(), approved("reviewer[BoT]")], /human login/u],
    ["blank reviewer", {}, [approved(), approved(" ")], /human login/u],
    [
      "no approved npm-release entry",
      {},
      [
        { ...approved(), state: "rejected" },
        { ...approved(), environments: [{ name: "clawhub-plugin-release" }] },
      ],
      /approved npm-release environment/u,
    ],
    ["wrong event", { GITHUB_EVENT_NAME: "push" }, [approved()], /workflow_dispatch/u],
    [
      "wrong workflow",
      { GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/other` },
      [approved()],
      /workflow ref/u,
    ],
    [
      "wrong repository",
      { GITHUB_REPOSITORY: "other/repository" },
      [approved()],
      /repository mismatch/u,
    ],
  ])("creates receipts only with valid authority: %s", (_label, override, approvals, message) => {
    const create = () =>
      createReleaseApprovalReceipt({ ...env, ...override }, (path: string) => {
        expect(path).toBe("actions/runs/10/approvals");
        return approvals;
      });
    if (message) {
      expect(create).toThrow(message);
    } else {
      expect(create()).toEqual(fixture().receipt);
    }
  });

  const ref = "release-publish/aaaaaaaaaaaa-42";
  const protectedTooling = { toolingRef: ref, toolingFullRef: `refs/tags/${ref}` };
  it.each<[Record<string, unknown>, RegExp | string | undefined]>([
    [{ releaseTag: "v2026.9.24-alpha.1" }, "Alpha releases are retired;"],
    [{ npmDistTag: "alpha" }, "Alpha releases are retired;"],
    [
      {
        toolingRef: "tideclaw/alpha/2026-09-24-1200Z",
        toolingFullRef: "refs/heads/tideclaw/alpha/2026-09-24-1200Z",
      },
      "Alpha releases are retired;",
    ],
    [{ parentRunId: "01" }, /parentRunId/u],
    [{ parentRunAttempt: "0" }, /parentRunAttempt/u],
    [{ releaseTag: "v2026.09.24" }, /Release tag/u],
    [{ targetSha: "invalid" }, /Target SHA/u],
    [{ npmDistTag: "default" }, /dist-tag/u],
    [{ approver: "x".repeat(8 * 1024) }, /8 KiB/u],
    [protectedTooling, undefined],
    [{ ...protectedTooling, toolingFullRef: `refs/heads/${ref}` }, /protected/u],
    [{ ...protectedTooling, toolingSha: "c".repeat(40) }, /protected/u],
  ])("validates receipt fields and protected tooling (%#)", (override, message) => {
    const receipt = { ...fixture().receipt, ...override };
    if (message) {
      expect(() => validateReleaseApprovalReceipt(receipt)).toThrow(message);
    } else {
      expect(validateReleaseApprovalReceipt(receipt)).toBe(receipt);
    }
  });

  const valid = fixture();
  const job = expectDefined(valid.parentJobs.jobs[0], "job");
  function receiptWith(overrides: Record<string, unknown>) {
    return { ...valid.receipt, ...overrides };
  }
  function jobs(overrides: Partial<typeof job>) {
    return { total_count: 1, jobs: [{ ...job, ...overrides }] };
  }
  function artifact(overrides: Partial<typeof valid.artifact.workflow_run>) {
    return { ...valid.artifact, workflow_run: { ...valid.artifact.workflow_run, ...overrides } };
  }
  it.each<[Partial<ReturnType<typeof fixture>>, RegExp]>([
    ...(
      [
        ["parentRunId", "11"],
        ["parentRunAttempt", "3"],
        ["toolingSha", "c".repeat(40)],
        ["releaseTag", "v2026.9.25-beta.1"],
        ["targetSha", "d".repeat(40)],
        ["npmDistTag", "latest"],
      ] as const
    ).map(([key, value]): [Partial<ReturnType<typeof fixture>>, RegExp] => [
      { expected: { ...valid.expected, [key]: value } },
      new RegExp(`${key} does not match`, "u"),
    ]),
    [{ receipt: receiptWith({ extra: true }) }, /fields/u],
    [{ receipt: receiptWith({ approver: "someone-else" }) }, /approver is not in/u],
    [{ artifact: artifact({ id: 11 }) }, /artifact parent run/u],
    [{ artifact: { ...valid.artifact, expired: true } }, /expired/u],
    [{ artifact: artifact({ head_repository_id: 100 }) }, /artifact repository/u],
    [
      {
        parentJobs: jobs({
          steps: [{ ...expectDefined(job.steps[0], "step"), conclusion: "failure" }],
        }),
      },
      /receipt step/u,
    ],
    [{ parentJobs: { total_count: 0, jobs: [] } }, /parent job must be unique/u],
    [{ parentJobs: { total_count: 2, jobs: [job, job] } }, /parent job must be unique/u],
    [{ parentJobs: jobs({ run_attempt: 1 }) }, /job identity/u],
  ])("rejects invalid receipt binding: %j", (override, message) => {
    expect(() => verifyReleaseApprovalReceipt({ ...fixture(), ...override })).toThrow(message);
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
    const expectedOutput = `artifact_name=${artifactName}\n`;
    const args = [resolve("scripts/release-approval-receipt.mjs"), "create", "--output", output];
    const options = {
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: githubOutput },
    } as const;
    const result = spawnSync(process.execPath, args, options);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`${JSON.stringify(fixture().receipt)}\n`);
    expect(readFileSync(githubOutput, "utf8")).toBe(expectedOutput);
    const second = spawnSync(process.execPath, args, options);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("EEXIST");
    expect(readFileSync(githubOutput, "utf8")).toBe(expectedOutput);
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
      [`actions/runs/10/artifacts?name=${artifactName}&per_page=100`]: {
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

describe("parent authorization wait", () => {
  const name = artifactName;
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
    requireInProgress: true,
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

  const completed = { status: "completed", conclusion: "failure" };
  type WaitOptions = { requireInProgress?: boolean; deadlineMs?: number };
  const wrongBinding = /does not belong to the parent/u;
  const binding = (id: number, head_sha = sha) => ({
    ...authorization,
    workflow_run: { id, head_sha },
  });
  it.each<[string, unknown[][], RegExp?, typeof completed?, WaitOptions?]>([
    ["waits for authorization", [[], [], [authorization]]],
    [
      "allows detached authorization",
      [[authorization]],
      undefined,
      completed,
      { requireInProgress: false },
    ],
    ["requires a live parent", [[authorization]], /completed\//u, completed],
    [
      "parent exits without authorization",
      [[]],
      /completed\/failure without authorizing/u,
      completed,
    ],
    ["deadline expires", [[]], /did not appear before the deadline/u, undefined, { deadlineMs: 0 }],
    ["wrong parent", [[binding(11)]], wrongBinding],
    ["wrong tooling", [[binding(10, targetSha)]], wrongBinding],
    ["expired", [[{ ...authorization, expired: true }]], wrongBinding],
    ["ambiguous", [[authorization, authorization]], /ambiguous/u],
  ])("%s", async (_name, pages, error, parent, options) => {
    const result = awaitParentAuthorization({
      ...params,
      ...options,
      runGhJson: api(pages, parent),
    });
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toEqual(authorization);
    }
  });
});

describe("parent authorization CLI", () => {
  it.each([
    ["wait-npm-authorization", "in_progress", null, 0, artifactName],
    ["wait-npm-authorization", "completed", "success", 1, artifactName],
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

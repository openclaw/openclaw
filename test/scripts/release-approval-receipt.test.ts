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
  const identity = {
    parentRunId: "10",
    parentRunAttempt: "2",
    toolingRef: "main",
    toolingFullRef: "refs/heads/main",
    toolingSha: sha,
    releaseTag: "v2026.9.24-beta.1",
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
    approvalJob: "Publish plugins, then OpenClaw",
    approver: "octocat",
  };
  return {
    receipt,
    expected: { repository, ...identity },
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

  it.each<[string, (input: ReturnType<typeof fixture>) => void, RegExp]>([
    ...(
      [
        ["parentRunId", "11"],
        ["parentRunAttempt", "3"],
        ["toolingSha", "c".repeat(40)],
        ["releaseTag", "v2026.9.25-beta.1"],
        ["targetSha", "d".repeat(40)],
        ["npmDistTag", "latest"],
      ] as const
    ).map(([key, value]): [string, (input: ReturnType<typeof fixture>) => void, RegExp] => [
      `different expected ${key}`,
      (input) => {
        input.expected[key] = value;
      },
      new RegExp(`${key} does not match`, "u"),
    ]),
    [
      "extra fields",
      (input) => {
        Object.assign(input.receipt, { extra: true });
      },
      /fields/u,
    ],
    [
      "tampered approver",
      (input) => {
        input.receipt.approver = "someone-else";
      },
      /approver is not in/u,
    ],
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
  ])("rejects %s", (_name, change, message) => {
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

describe("parent authorization wait", () => {
  const name = "openclaw-release-approval-v1-10-2";
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
  type AuthorizationCase = {
    name: string;
    pages: unknown[][];
    parent?: typeof completed;
    options?: { requireInProgress?: boolean; deadlineMs?: number };
    error?: RegExp;
  };
  it.each<AuthorizationCase>([
    { name: "waits for authorization", pages: [[], [], [authorization]] },
    {
      name: "allows detached authorization",
      pages: [[authorization]],
      parent: completed,
      options: { requireInProgress: false },
    },
    {
      name: "requires a live parent",
      pages: [[authorization]],
      parent: completed,
      error: /completed\//u,
    },
    {
      name: "parent exits without authorization",
      pages: [[]],
      parent: completed,
      error: /completed\/failure without authorizing/u,
    },
    {
      name: "deadline expires",
      pages: [[]],
      options: { deadlineMs: 0 },
      error: /did not appear before the deadline/u,
    },
    {
      name: "wrong parent",
      pages: [[{ ...authorization, workflow_run: { id: 11, head_sha: sha } }]],
      error: /does not belong to the parent/u,
    },
    {
      name: "wrong tooling",
      pages: [[{ ...authorization, workflow_run: { id: 10, head_sha: targetSha } }]],
      error: /does not belong to the parent/u,
    },
    {
      name: "expired",
      pages: [[{ ...authorization, expired: true }]],
      error: /does not belong to the parent/u,
    },
    { name: "ambiguous", pages: [[authorization, authorization]], error: /ambiguous/u },
  ])("$name", async ({ pages, parent, options, error }) => {
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
    ["wait-npm-authorization", "in_progress", null, 0, "openclaw-release-approval-v1-10-2"],
    ["wait-npm-authorization", "completed", "success", 1, "openclaw-release-approval-v1-10-2"],
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

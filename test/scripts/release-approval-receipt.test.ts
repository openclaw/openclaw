import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

function approved(login = "octocat", state = "approved", environment = "npm-release") {
  return { state, environments: [{ name: environment }], user: { login } };
}

function artifactListing(...artifacts: unknown[]) {
  return { total_count: artifacts.length, artifacts };
}

function writeGh(directory: string, source: string) {
  writeFileSync(join(directory, "gh"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

function runCli(command: string, cliEnv: NodeJS.ProcessEnv, args: string[] = []) {
  const argv = [resolve("scripts/release-approval-receipt.mjs"), command, ...args];
  return spawnSync(process.execPath, argv, { encoding: "utf8", env: cliEnv });
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
  const job = {
    name: approvalJob,
    head_sha: sha,
    run_id: 10,
    run_attempt: 2,
    status: "in_progress",
    steps: [{ name: receiptStep, status: "completed", conclusion: "success" }],
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
      head_branch: "main",
      head_sha: sha,
      path: workflow,
      status: "in_progress",
      conclusion: null as string | null,
    },
    parentJobs: { total_count: 1, jobs: [job] },
    approvals: [approved()],
  };
}

describe("release approval receipt", () => {
  it.each<[Partial<typeof env>, RegExp?, ReturnType<typeof approved>[]?]>([
    [
      {},
      undefined,
      [
        approved("earlier-reviewer"),
        approved(),
        approved("rejected-reviewer", "rejected"),
        approved("other-reviewer", "approved", "other-environment"),
      ],
    ],
    [{}, /human login/u, [approved(), approved("reviewer[BoT]")]],
    [{}, /human login/u, [approved(), approved(" ")]],
    [
      {},
      /approved npm-release environment/u,
      [approved(undefined, "rejected"), approved(undefined, "approved", "clawhub-plugin-release")],
    ],
    [{ GITHUB_EVENT_NAME: "push" }, /workflow_dispatch/u],
    [{ GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/other` }, /workflow ref/u],
    [{ GITHUB_REPOSITORY: "other/repository" }, /repository mismatch/u],
  ])(
    "creates receipts only with valid authority: %j",
    (override, error, approvals = [approved()]) => {
      const create = () =>
        createReleaseApprovalReceipt({ ...env, ...override }, (path: string) => {
          expect(path).toBe("actions/runs/10/approvals");
          return approvals;
        });
      if (error) {
        expect(create).toThrow(error);
      } else {
        expect(create()).toEqual(fixture().receipt);
      }
    },
  );

  const ref = "release-publish/aaaaaaaaaaaa-42";
  const protectedTooling = { toolingRef: ref, toolingFullRef: `refs/tags/${ref}` };
  const alphaRef = "tideclaw/alpha/2026-09-24-1200Z";
  it.each<[Record<string, unknown>, RegExp | string | undefined]>([
    [{ releaseTag: "v2026.9.24-alpha.1" }, "Alpha releases are retired;"],
    [{ npmDistTag: "alpha" }, "Alpha releases are retired;"],
    [
      {
        toolingRef: alphaRef,
        toolingFullRef: `refs/heads/${alphaRef}`,
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
  const failedStep = { ...expectDefined(job.steps[0], "step"), conclusion: "failure" };
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
    ...Object.entries({
      parentRunId: "11",
      parentRunAttempt: "3",
      toolingSha: "c".repeat(40),
      releaseTag: "v2026.9.25-beta.1",
      targetSha: "d".repeat(40),
      npmDistTag: "latest",
    }).map(([key, value]): [Partial<ReturnType<typeof fixture>>, RegExp] => [
      { expected: { ...valid.expected, [key]: value } },
      new RegExp(`${key} does not match`, "u"),
    ]),
    [{ receipt: receiptWith({ extra: true }) }, /fields/u],
    [{ receipt: receiptWith({ approver: "someone-else" }) }, /approver is not in/u],
    [{ artifact: artifact({ id: 11 }) }, /artifact parent run/u],
    [{ artifact: { ...valid.artifact, expired: true } }, /expired/u],
    [{ artifact: artifact({ head_repository_id: 100 }) }, /artifact repository/u],
    [{ parentJobs: jobs({ steps: [failedStep] }) }, /receipt step/u],
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
    writeGh(
      directory,
      `if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["api", "repos/openclaw/openclaw/actions/runs/10/approvals", "--method", "GET"])) process.exit(1);
console.log(${JSON.stringify(JSON.stringify([approved()]))});
`,
    );
    const output = join(directory, "receipt", "approval.json");
    const githubOutput = join(directory, "output");
    const expectedOutput = `artifact_name=${artifactName}\n`;
    const create = () =>
      runCli(
        "create",
        { ...env, PATH: `${directory}:${process.env.PATH}`, GITHUB_OUTPUT: githubOutput },
        ["--output", output],
      );
    const result = create();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`${JSON.stringify(fixture().receipt)}\n`);
    expect(readFileSync(githubOutput, "utf8")).toBe(expectedOutput);
    const second = create();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("EEXIST");
    expect(readFileSync(githubOutput, "utf8")).toBe(expectedOutput);
  });
});

describe("release approval artifact download", () => {
  async function downloadFixture(count = 1) {
    const input = fixture();
    const archive = await new JSZip()
      .file("approval.json", JSON.stringify(input.receipt, null, 2) + "\n")
      .generateAsync({ type: "nodebuffer" });
    const artifact = {
      ...input.artifact,
      size_in_bytes: archive.length,
      digest: "sha256:" + createHash("sha256").update(archive).digest("hex"),
      expires_at: "2026-10-24T00:00:00Z",
    };
    const responses: Record<string, unknown> = {
      ["actions/runs/10/artifacts?name=" + artifactName + "&per_page=100"]: artifactListing(
        ...Array.from({ length: count }, () => artifact),
      ),
      "actions/runs/10/attempts/2":
        count === 1
          ? input.parentRun
          : { ...input.parentRun, status: "completed", conclusion: "failure" },
      "actions/runs/10/attempts/2/jobs?per_page=100": input.parentJobs,
      "actions/runs/10/approvals": input.approvals,
    };
    const download = () =>
      downloadReleaseApprovalReceipt({
        expected: input.expected,
        token: "synthetic-token",
        runGhJson: (path: string) => {
          expect(responses).toHaveProperty(path);
          return responses[path];
        },
        fetchImpl: async (url: string) => {
          if (count !== 1) {
            throw new Error("unexpected download");
          }
          const base = "https://api.github.com/repos/openclaw/openclaw/actions/artifacts/50";
          if (url === base) {
            return Response.json(artifact);
          }
          expect(url).toBe(base + "/zip");
          return new Response(new Uint8Array(archive));
        },
      });
    return { download, receipt: input.receipt, artifact };
  }

  it("downloads the digest-bound archive and verifies fresh parent metadata", async () => {
    const { download, receipt, artifact } = await downloadFixture();
    expect(await download()).toEqual({ receipt, artifact });
  });

  it.each([0, 2])(
    "rejects %i matching artifacts when the parent cannot supply a receipt",
    async (count) => {
      const { download } = await downloadFixture(count);
      await expect(download()).rejects.toThrow(
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
        return artifactListing(...page);
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
  it.each<[unknown[][], RegExp?, typeof completed?, WaitOptions?]>([
    [[[], [], [authorization]]],
    [[[authorization]], undefined, completed, { requireInProgress: false }],
    [[[authorization]], /completed\//u, completed],
    [[[]], /completed\/failure without authorizing/u, completed],
    [[[]], /did not appear before the deadline/u, undefined, { deadlineMs: 0 }],
    [[[binding(11)]], wrongBinding],
    [[[binding(10, targetSha)]], wrongBinding],
    [[[{ ...authorization, expired: true }]], wrongBinding],
    [[[authorization, authorization]], /ambiguous/u],
  ])("validates parent authorization (%#): %j", async (pages, error, parent, options) => {
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
      [`repos/openclaw/openclaw/actions/runs/10/artifacts?name=${name}&per_page=100`]:
        artifactListing(artifact),
      "repos/openclaw/openclaw/actions/runs/10/attempts/2": { status, conclusion },
    };
    writeGh(
      directory,
      `const responses = ${JSON.stringify(responses)};
const response = responses[process.argv[3]];
if (!response) process.exit(2);
console.log(JSON.stringify(response));
`,
    );
    const result = runCli(command, {
      PATH: `${directory}:${process.env.PATH}`,
      RELEASE_PUBLISH_RUN_ID: "10",
      RELEASE_PUBLISH_RUN_ATTEMPT: "2",
      EXPECTED_WORKFLOW_SHA: sha,
      GITHUB_RUN_ID: "30",
      GITHUB_RUN_ATTEMPT: "1",
    });
    expect(result.status, result.stderr).toBe(exitCode);
    if (exitCode === 0) {
      expect(result.stdout).toContain(name);
    } else {
      expect(result.stderr).toContain(`completed/${conclusion} without authorizing`);
    }
  },
);

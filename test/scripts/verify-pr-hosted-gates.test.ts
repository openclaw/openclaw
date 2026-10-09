import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  collectHostedGateEvidence as collectHostedGateEvidenceRaw,
  HOSTED_GATE_MAX_AGE_HOURS,
  loadPullRequestCommitShas,
  main,
  notApplicableScheduledHostedWorkflows,
  parseArgs,
  parseWorkflowRunPage,
  SCHEDULED_HOSTED_WORKFLOWS,
  workflowRunQueryPaths,
  workflowRunPageCount,
} from "../../scripts/verify-pr-hosted-gates.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

const testNodeExecPath = resolveTestNodeExecPath();

const sha = "773ffd87a1e1e34451ad6e38fda37380c2569a50";
const mainSha = "d".repeat(40);
const previousSha = "8d86c44c6144f8f726a460914cddb8c9c201f119";
const scheduledFallbackSha = "ad620a11e5d9ed3888b6afb3c35c4c30e8054f4e";
const pr = 100606;
const nowMs = Date.parse("2026-06-17T10:55:00Z");
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";
const requiredCliArgs = [
  "--repo",
  "openclaw/openclaw",
  "--sha",
  sha,
  "--pr",
  String(pr),
  "--output",
  ".local/gates-hosted-checks.json",
  "--main-sha",
  mainSha,
];

type WorkflowRunFixture = {
  id: number;
  run_number: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  pull_requests: Array<{ number: number }>;
  path: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  display_title?: string;
};

function successfulRun(
  name: string,
  id: number,
  updatedAt: string,
  overrides: Partial<WorkflowRunFixture> = {},
): WorkflowRunFixture {
  return {
    id,
    run_number: id,
    name,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "codex/clean-expanded-tool-calls",
    head_repository: { full_name: "openclaw/openclaw" },
    pull_requests: [{ number: pr }],
    path: ".github/workflows/ci.yml",
    created_at: "2026-06-17T10:46:24Z",
    updated_at: updatedAt,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${id}`,
    ...overrides,
  };
}

function releaseGateRun(id: number, updatedAt: string) {
  return successfulRun(`CI release gate ${sha}`, id, updatedAt, {
    event: "workflow_dispatch",
    display_title: `CI release gate ${sha}`,
  });
}

function pendingCiRun(id: number, updatedAt: string, status = "queued") {
  return { ...successfulRun("CI", id, updatedAt), status, conclusion: null };
}

function queuedBuildArtifactFallbackRuns() {
  return [
    releaseGateRun(1, "2026-06-17T10:49:00Z"),
    successfulRun("CI", 3, "2026-06-17T10:51:00Z"),
    successfulRun("Blacksmith Testbox", 4, "2026-06-17T10:52:00Z"),
    successfulRun("Blacksmith ARM Testbox", 5, "2026-06-17T10:53:00Z"),
    successfulRun("Workflow Sanity", 6, "2026-06-17T10:54:00Z"),
    successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z", {
      status: "queued",
      conclusion: null,
    }),
  ];
}

function collectHostedGateEvidence(
  options: Omit<CollectHostedGateOptions, "nowMs" | "pr" | "mainSha">,
) {
  return collectHostedGateEvidenceRaw({ nowMs, pr, mainSha, ...options });
}

type GitExec = (args: string[], options?: { input?: string }) => string;
type CollectHostedGateOptions = Parameters<typeof collectHostedGateEvidenceRaw>[0];

function priorSuccessfulCiRun(overrides: Partial<WorkflowRunFixture> = {}): WorkflowRunFixture {
  return {
    ...successfulRun("CI", 101, "2026-06-17T09:55:00Z"),
    head_sha: previousSha,
    ...overrides,
  };
}

type PatchIdExecOptions = {
  currentPatchId?: string;
  priorPatchId?: string;
  unfetchableShas?: Set<string>;
  failCommand?: string;
};

function createPatchIdExec({
  currentPatchId: suppliedCurrentPatchId = "a".repeat(40),
  priorPatchId,
  unfetchableShas = new Set<string>(),
  failCommand = "",
}: PatchIdExecOptions = {}) {
  const currentPatchId: string = suppliedCurrentPatchId;
  const resolvedPriorPatchId = priorPatchId ?? currentPatchId;
  const calls: string[] = [];
  const execGit: GitExec = (args, options = {}) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === failCommand) {
      throw new Error(`mock failure: ${command}`);
    }
    switch (args[0]) {
      case "cat-file": {
        const candidateSha = args[2]?.replace(/\^\{commit\}$/u, "") ?? "";
        if (unfetchableShas.has(candidateSha)) {
          throw new Error("missing object");
        }
        return "";
      }
      case "fetch":
        if (unfetchableShas.has(args[2] ?? "")) {
          throw new Error("unfetchable object");
        }
        return "";
      case "merge-base":
        return `${(args[2] === sha ? "b" : "c").repeat(40)}\n`;
      case "diff":
        return `diff:${args[2]}`;
      case "patch-id": {
        const patchId = options.input === `diff:${sha}` ? currentPatchId : resolvedPriorPatchId;
        return `${patchId} ${"0".repeat(40)}\n`;
      }
      default:
        throw new Error(`unexpected git command: ${command}`);
    }
  };
  return { calls, execGit };
}

function patchReuseOptions(
  candidate: WorkflowRunFixture = priorSuccessfulCiRun(),
  execGit = createPatchIdExec().execGit,
) {
  return {
    loadCiReuseCandidates: () => [candidate],
    execGit,
  };
}

describe("verify-pr-hosted-gates", () => {
  it("compares patch IDs against one main snapshot while the shared ref advances", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-patch-snapshot-")));
    const git: GitExec = (args, options) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input: options?.input });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.name", "OpenClaw Test"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "commit.gpgSign", "false"]);
      git(["config", "core.hooksPath", "/dev/null"]);
      writeFileSync(join(root, "subject.txt"), "base\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const snapshot = git(["rev-parse", "HEAD"]).trim();
      git(["update-ref", "refs/remotes/origin/main", snapshot]);
      writeFileSync(join(root, "subject.txt"), "reviewed\n");
      git(["commit", "-qam", "reviewed"]);
      const target = git(["rev-parse", "HEAD"]).trim();
      git(["commit", "--allow-empty", "-qm", "same tree, different commit"]);
      const candidate = git(["rev-parse", "HEAD"]).trim();
      let comparisons = 0;
      const evidence = collectHostedGateEvidenceRaw({
        sha: target,
        mainSha: snapshot,
        pr,
        nowMs,
        workflowRuns: [],
        loadCiReuseCandidates: () => [priorSuccessfulCiRun({ head_sha: candidate })],
        execGit: (args, options) => {
          const result = git(args, options);
          if (args[0] === "patch-id" && ++comparisons === 1) {
            git(["update-ref", "refs/remotes/origin/main", candidate]);
          }
          return result;
        },
      });
      expect(evidence.reusedFromSha).toBe(candidate);
      expect(evidence.patchIdMatched).toBe(true);
      expect(comparisons).toBe(2);
      expect(git(["rev-parse", "refs/remotes/origin/main"]).trim()).toBe(candidate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts from an older target cwd without current normalization helpers", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "openclaw-hosted-gates-old-cwd-"));
    try {
      const normalizationRoot = join(targetRoot, "packages/normalization-core/src");
      mkdirSync(normalizationRoot, { recursive: true });
      writeFileSync(
        join(targetRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@openclaw/normalization-core/*": ["packages/normalization-core/src/*"],
            },
          },
        }),
      );
      writeFileSync(join(normalizationRoot, "number-coercion.ts"), "export const legacy = true;\n");
      writeFileSync(
        join(normalizationRoot, "record-coerce.ts"),
        [
          "export function isRecord(value: unknown): value is Record<string, unknown> {",
          '  return typeof value === "object" && value !== null && !Array.isArray(value);',
          "}",
          "export function readStringField(record: Record<string, unknown>, key: string) {",
          "  const value = record[key];",
          '  return typeof value === "string" ? value : undefined;',
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        testNodeExecPath,
        [join(process.cwd(), "scripts/verify-pr-hosted-gates.mjs"), "--older-cwd-startup-probe"],
        {
          cwd: targetRoot,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option: --older-cwd-startup-probe");
    } finally {
      rmSync(targetRoot, { force: true, recursive: true });
    }
  });

  it("derives hosted-gate applicability from declared workflow path filters", () => {
    expect(notApplicableScheduledHostedWorkflows([".github/workflows/ci.yml"])).toEqual([
      "Blacksmith Testbox",
      "Blacksmith ARM Testbox",
      "Blacksmith Build Artifacts Testbox",
    ]);
    expect(
      notApplicableScheduledHostedWorkflows([".github/actions/setup-node-env/action.yml"]),
    ).toEqual([]);
    expect(
      notApplicableScheduledHostedWorkflows(["test/e2e/qa-lab/runtime/script-evidence.ts"]),
    ).toEqual([
      "Blacksmith Testbox",
      "Blacksmith ARM Testbox",
      "Blacksmith Build Artifacts Testbox",
    ]);
    expect(notApplicableScheduledHostedWorkflows(["CHANGELOG.md"])).toEqual(
      SCHEDULED_HOSTED_WORKFLOWS,
    );
  });

  it("requires an authoritative ARM run when declared workflow paths apply", () => {
    const workflowRuns = [
      successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
      successfulRun("Blacksmith Testbox", 2, "2026-06-17T10:48:00Z"),
      successfulRun("Blacksmith Build Artifacts Testbox", 3, "2026-06-17T10:49:00Z"),
      successfulRun("Workflow Sanity", 4, "2026-06-17T10:50:00Z"),
    ];

    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns,
        notApplicableScheduledWorkflows: [],
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${sha}`);
  });

  it("records path-filtered hosted gates as not applicable for QA-only changes", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
        successfulRun("Workflow Sanity", 2, "2026-06-17T10:48:00Z"),
      ],
      notApplicableScheduledWorkflows: [
        "Blacksmith Testbox",
        "Blacksmith ARM Testbox",
        "Blacksmith Build Artifacts Testbox",
      ],
    });

    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", id: 1 }),
      expect.objectContaining({ name: "Workflow Sanity", id: 2 }),
    ]);
    expect(evidence.notApplicableWorkflows).toEqual([
      "Blacksmith Testbox",
      "Blacksmith ARM Testbox",
      "Blacksmith Build Artifacts Testbox",
    ]);
  });

  it("does not require path-inapplicable ARM proof for queued artifact fallback", () => {
    const workflowRuns = queuedBuildArtifactFallbackRuns().filter(
      (run) => run.name !== "Blacksmith ARM Testbox",
    );
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns,
      notApplicableScheduledWorkflows: ["Blacksmith ARM Testbox"],
    });

    expect(evidence.fallbackCoveredWorkflows).toEqual([
      {
        name: BUILD_ARTIFACTS_WORKFLOW,
        coveredBy: "CI release gate",
        reason: "scheduled workflow is queued",
      },
    ]);
    expect(evidence.notApplicableWorkflows).toEqual(["Blacksmith ARM Testbox"]);
  });

  it.each([
    { name: "different patch", options: { priorPatchId: "d".repeat(40) }, fetch: false },
    { name: "unfetchable head", options: { unfetchableShas: new Set([previousSha]) }, fetch: true },
    {
      name: "failed patch proof",
      options: { failCommand: `merge-base ${mainSha} ${previousSha}` },
      fetch: false,
    },
  ] satisfies Array<{ name: string; options: PatchIdExecOptions; fetch: boolean }>)(
    "rejects CI reuse with $name",
    ({ options, fetch }) => {
      const { calls, execGit } = createPatchIdExec(options);
      expect(() =>
        collectHostedGateEvidence({
          sha,
          workflowRuns: [],
          ...patchReuseOptions(priorSuccessfulCiRun(), execGit),
        }),
      ).toThrow(`Missing successful recent CI workflow for ${sha}`);
      if (fetch) {
        expect(calls).toContain(`fetch origin ${previousSha}`);
      }
    },
  );

  it("filters prior runs by successful qualifying CI shape", () => {
    const invalidCandidates = [
      priorSuccessfulCiRun({ updated_at: "2026-06-16T10:54:59Z" }),
      priorSuccessfulCiRun({ id: 1, conclusion: "failure" }),
      priorSuccessfulCiRun({ id: 2, name: "Docs" }),
      priorSuccessfulCiRun({
        id: 3,
        event: "workflow_dispatch",
        display_title: `CI release gate ${previousSha}`,
        path: ".github/workflows/not-ci.yml",
      }),
    ];
    let gitCalled = false;
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        loadCiReuseCandidates: () => invalidCandidates,
        execGit: () => {
          gitCalled = true;
          throw new Error("invalid candidates must be filtered before git");
        },
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
    expect(gitCalled).toBe(false);
  });

  it("accepts a patch-identical prior release-gate run with the exact dispatch title", () => {
    const candidate = priorSuccessfulCiRun({
      id: 102,
      event: "workflow_dispatch",
      path: ".github/workflows/ci.yml",
      display_title: `CI release gate ${previousSha}`,
    });
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        ...patchReuseOptions(candidate),
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ id: 102, event: "workflow_dispatch" })],
      reusedFromSha: previousSha,
      reusedRunId: 102,
      patchIdMatched: true,
    });
  });

  it("short-circuits reuse discovery when exact-head CI already succeeds", () => {
    let reuseCalled = false;
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [successfulRun("CI", 1, "2026-06-17T10:47:00Z")],
      loadCiReuseCandidates: () => {
        reuseCalled = true;
        throw new Error("exact-head success must not inspect reuse candidates");
      },
      execGit: () => {
        reuseCalled = true;
        throw new Error("exact-head success must not execute git reuse proof");
      },
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ id: 1, headSha: sha })],
    });
    expect(reuseCalled).toBe(false);
  });

  it("accepts an in-progress CI run whose own attempt's ci-gate job succeeded", () => {
    const inProgressRun = {
      ...successfulRun("CI", 42, "2026-06-17T10:52:00Z"),
      status: "in_progress",
      conclusion: null,
      run_attempt: 2,
    };
    const gateJob = {
      name: "openclaw/ci-gate",
      run_id: 42,
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
      completed_at: "2026-06-17T10:51:30Z",
    };

    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [inProgressRun],
      ciGateJobs: [gateJob],
    });
    expect(evidence.workflows.map((workflow: { id: unknown }) => workflow.id)).toContain(42);

    // A prior attempt's gate (same run id, older run_attempt) cannot vouch for
    // a partial rerun in progress.
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [inProgressRun],
        ciGateJobs: [{ ...gateJob, run_attempt: 1 }],
      }),
    ).toThrow(/Missing successful recent CI workflow/);

    // A gate job from a different run, a failed gate, and a missing gate all
    // fall back to requiring run completion.
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [inProgressRun],
        ciGateJobs: [{ ...gateJob, run_id: 41 }],
      }),
    ).toThrow(/Missing successful recent CI workflow/);
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [inProgressRun],
        ciGateJobs: [{ ...gateJob, conclusion: "failure" }],
      }),
    ).toThrow(/Missing successful recent CI workflow/);
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [inProgressRun], ciGateJobs: [] }),
    ).toThrow(/Missing successful recent CI workflow/);
  });

  it("lets a gate-proven pending rerun win over an older terminal failure", () => {
    const failedRun = successfulRun("CI", 40, "2026-06-17T10:40:00Z", {
      conclusion: "failure",
    });
    const pendingRerun = {
      ...successfulRun("CI", 42, "2026-06-17T10:52:00Z"),
      status: "in_progress",
      conclusion: null,
      run_attempt: 1,
      created_at: "2026-06-17T10:50:00Z",
    };
    const gateJob = {
      name: "openclaw/ci-gate",
      run_id: 42,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      completed_at: "2026-06-17T10:51:30Z",
    };

    // The newer pending run is re-resolving the failure; its successful gate
    // proves the selected lanes, so the stale failure must not block.
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [failedRun, pendingRerun],
      ciGateJobs: [gateJob],
    });
    expect(evidence.workflows.map((workflow: { id: unknown }) => workflow.id)).toContain(42);

    // Without gate proof the pending run still blocks (no early acceptance),
    // and a failure that IS the latest scheduled run still blocks outright.
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [failedRun, pendingRerun], ciGateJobs: [] }),
    ).toThrow(/Missing successful recent CI workflow/);
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [failedRun], ciGateJobs: [gateJob] }),
    ).toThrow(/Missing successful recent CI workflow/);

    // A stalled OLDER run's gate must not mask a newer terminal failure.
    const stalledOlderRun = { ...pendingRerun, created_at: "2026-06-17T10:40:00Z" };
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [failedRun, stalledOlderRun],
        ciGateJobs: [gateJob],
      }),
    ).toThrow(/Missing successful recent CI workflow/);
  });

  it.each(["Blacksmith ARM Testbox"])(
    "retains the newest non-skipped %s decision by creation order",
    (workflowName) => {
      const evidence = collectHostedGateEvidence({
        sha,
        workflowRuns: [
          successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
          successfulRun(workflowName, 10, "2026-06-17T10:54:00Z"),
          successfulRun(workflowName, 20, "2026-06-17T10:53:00Z"),
          {
            ...successfulRun(workflowName, 30, "2026-06-17T10:50:00Z"),
            conclusion: "skipped",
          },
        ],
      });

      expect(evidence.workflows).toEqual([
        expect.objectContaining({ name: "CI", id: 1 }),
        expect.objectContaining({ name: workflowName, id: 20 }),
      ]);
    },
  );

  it.each(["Blacksmith ARM Testbox"])(
    "covers queued artifacts after a skipped duplicate of supporting %s",
    (workflowName) => {
      const workflowRuns = queuedBuildArtifactFallbackRuns();
      const supportingRun = expectDefined(
        workflowRuns.find((run) => run.name === workflowName),
        "successful supporting workflow",
      );
      const evidence = collectHostedGateEvidence({
        sha,
        workflowRuns: [
          ...workflowRuns,
          {
            ...successfulRun(workflowName, 30, "2026-06-17T10:50:00Z"),
            conclusion: "skipped",
          },
        ],
      });

      expect(evidence.workflows).toContainEqual(
        expect.objectContaining({ name: workflowName, id: supportingRun.id }),
      );
      expect(evidence.fallbackCoveredWorkflows).toEqual([
        {
          name: BUILD_ARTIFACTS_WORKFLOW,
          coveredBy: "CI release gate",
          reason: "scheduled workflow is queued",
        },
      ]);
    },
  );

  it.each(["Blacksmith ARM Testbox"])(
    "does not look past a non-skipped unsuccessful %s decision",
    (workflowName) => {
      for (const [status, conclusion] of [
        ["completed", "failure"],
        ["completed", "cancelled"],
        ["completed", "timed_out"],
        ["completed", "action_required"],
        ["completed", "neutral"],
        ["completed", "unknown"],
        ["completed", null],
        ["queued", null],
        ["in_progress", null],
        ["unknown", "skipped"],
        ["in_progress", "skipped"],
      ] as const) {
        expect(
          () =>
            collectHostedGateEvidence({
              sha,
              workflowRuns: [
                successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
                successfulRun(workflowName, 10, "2026-06-17T10:54:00Z"),
                {
                  ...successfulRun(workflowName, 20, "2026-06-17T10:53:00Z"),
                  run_attempt: 2,
                  status,
                  conclusion,
                },
                {
                  ...successfulRun(workflowName, 30, "2026-06-17T10:50:00Z"),
                  conclusion: "skipped",
                },
              ],
            }),
          `${status}/${conclusion}`,
        ).toThrow(`Missing successful recent ${workflowName} workflow`);
      }
    },
  );

  it.each(["Blacksmith ARM Testbox"])(
    "requires eligible recent %s success before a skipped duplicate",
    (workflowName) => {
      const success = successfulRun(workflowName, 10, "2026-06-17T10:54:00Z");
      const cases: Array<[string, WorkflowRunFixture[]]> = [
        ["skip only", []],
        ["stale", [{ ...success, updated_at: "2026-06-16T10:54:59Z" }]],
        ["future", [{ ...success, updated_at: "2026-06-17T11:01:00Z" }]],
        ["manual", [{ ...success, event: "workflow_dispatch" }]],
        ["wrong workflow", [{ ...success, name: "Unrelated" }]],
        [
          "wrong head without PR membership",
          [{ ...success, head_sha: previousSha, pull_requests: [{ number: pr + 1 }] }],
        ],
      ];
      for (const [label, earlierRuns] of cases) {
        expect(
          () =>
            collectHostedGateEvidence({
              sha,
              workflowRuns: [
                successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
                ...earlierRuns,
                {
                  ...successfulRun(workflowName, 30, "2026-06-17T10:50:00Z"),
                  conclusion: "skipped",
                },
              ],
            }),
          label,
        ).toThrow(`Missing successful recent ${workflowName} workflow`);
      }
    },
  );

  it("keeps skipped artifact history ineligible for queued-artifact coverage", () => {
    for (const id of [0, 30]) {
      expect(() =>
        collectHostedGateEvidence({
          sha,
          workflowRuns: [
            ...queuedBuildArtifactFallbackRuns(),
            {
              ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, id, "2026-06-17T10:50:00Z"),
              conclusion: "skipped",
            },
          ],
        }),
      ).toThrow("Missing successful recent Blacksmith Build Artifacts Testbox workflow");
    }
  });

  it("requires the latest scheduled workflow run to pass", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
        successfulRun("Blacksmith Testbox", 2, "2026-06-17T10:47:30Z", {
          event: "workflow_dispatch",
        }),
        successfulRun("Blacksmith Testbox", 3, "2026-06-17T10:48:00Z"),
        successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:49:00Z"),
        successfulRun("Blacksmith Build Artifacts Testbox", 5, "2026-06-17T10:50:00Z"),
        successfulRun("Workflow Sanity", 6, "2026-06-17T10:51:00Z"),
      ],
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [
        expect.objectContaining({ name: "CI", id: 1 }),
        expect.objectContaining({ name: "Blacksmith Testbox", id: 3 }),
        expect.objectContaining({ name: "Blacksmith ARM Testbox", id: 4 }),
        expect.objectContaining({ name: "Blacksmith Build Artifacts Testbox", id: 5 }),
        expect.objectContaining({ name: "Workflow Sanity", id: 6 }),
      ],
    });
  });

  it("rejects a failed rerun of a workflow that was scheduled for the exact head", () => {
    const workflowRuns = ["CI", ...SCHEDULED_HOSTED_WORKFLOWS].map((name, index) =>
      successfulRun(name, index + 1, `2026-06-17T10:4${index}:00Z`),
    );
    workflowRuns[2] = {
      ...expectDefined(workflowRuns[2], "Blacksmith ARM Testbox workflow run"),
      conclusion: "failure",
      updated_at: "2026-06-17T10:50:00Z",
    };

    expect(() => collectHostedGateEvidence({ sha, workflowRuns })).toThrow(
      "Missing successful recent Blacksmith ARM Testbox workflow",
    );
  });

  it.each([
    {
      name: "scheduled CI at the age boundary",
      runs: [successfulRun("CI", 1, "2026-06-16T10:55:00Z")],
      selected: { name: "CI", id: 1 },
    },
    {
      name: "manual CI at the age boundary",
      runs: [
        successfulRun(`CI release gate ${sha}`, 1, "2026-06-16T10:55:00Z", {
          event: "workflow_dispatch",
          path: ".github/workflows/ci.yml@refs/heads/release-controls",
          display_title: `CI release gate ${sha}`,
        }),
      ],
      selected: { name: `CI release gate ${sha}`, id: 1 },
    },
    {
      name: "later success after failure",
      runs: [
        successfulRun("CI", 1, "2026-06-17T10:50:00Z", { conclusion: "failure" }),
        successfulRun("CI", 2, "2026-06-17T10:52:00Z"),
      ],
      selected: { name: "CI", id: 2, headSha: sha },
    },
    {
      name: "target success before obsolete-head failure",
      runs: [
        successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
        successfulRun("CI", 2, "2026-06-17T10:54:00Z", {
          head_sha: previousSha,
          conclusion: "failure",
        }),
      ],
      selected: { name: "CI", id: 1, headSha: sha },
    },
    ...(
      [
        ["stale", successfulRun("CI", 1, "2026-06-16T10:54:59Z")],
        ["cancelled", successfulRun("CI", 1, "2026-06-17T10:50:00Z", { conclusion: "cancelled" })],
        ["skipped", successfulRun("CI", 1, "2026-06-17T10:50:00Z", { conclusion: "skipped" })],
      ] satisfies Array<[string, WorkflowRunFixture]>
    ).map(([state, run]) => ({
      name: `manual fallback after ${state}`,
      runs: [run, releaseGateRun(2, "2026-06-17T10:49:00Z")],
      selected: { name: `CI release gate ${sha}`, id: 2 },
    })),
    {
      name: "newer manual over older pending",
      runs: [
        pendingCiRun(1, "2026-06-17T10:48:00Z", "in_progress"),
        releaseGateRun(2, "2026-06-17T10:49:00Z"),
      ],
      selected: { name: `CI release gate ${sha}`, id: 2 },
    },
  ])("selects $name", ({ runs, selected }) => {
    expect(collectHostedGateEvidence({ sha, workflowRuns: runs })).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining(selected)],
    });
  });

  it("accepts a recent green fork head when GitHub omits pull request links", () => {
    const headBranch = "fix/token-listener";
    const headRepository = "contributor/openclaw";
    const priorRun = successfulRun("CI", 1, "2026-06-17T10:50:00Z", {
      head_sha: previousSha,
      head_branch: headBranch,
      head_repository: { full_name: headRepository },
      pull_requests: [],
    });
    const evidence = collectHostedGateEvidence({
      sha,
      pullRequestCommitShas: [previousSha, sha],
      pullRequestHeadBranch: headBranch,
      pullRequestHeadRepository: headRepository,
      workflowRuns: [
        priorRun,
        successfulRun("CI", 2, "2026-06-17T10:54:00Z", {
          head_branch: headBranch,
          head_repository: { full_name: headRepository },
          pull_requests: [],
          conclusion: "failure",
        }),
      ],
      ...patchReuseOptions(priorRun),
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it.each([
    { name: "unlinked PR commit", commits: [previousSha, sha], links: [], accepted: true },
    { name: "unlinked non-PR commit", commits: [sha], links: [], accepted: false },
    {
      name: "PR commit explicitly linked to another PR",
      commits: [previousSha, sha],
      links: [{ number: pr + 1 }],
      accepted: false,
    },
  ])("validates scheduled fallback membership for $name", ({ commits, links, accepted }) => {
    const headBranch = "fix/token-listener";
    const headRepository = "contributor/openclaw";
    const collect = () =>
      collectHostedGateEvidence({
        sha,
        pullRequestCommitShas: commits,
        pullRequestHeadBranch: headBranch,
        pullRequestHeadRepository: headRepository,
        workflowRuns: [
          successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          successfulRun("Blacksmith ARM Testbox", 2, "2026-06-17T10:54:00Z", {
            status: "queued",
            conclusion: null,
          }),
          successfulRun("Blacksmith ARM Testbox", 3, "2026-06-17T10:53:00Z", {
            head_sha: previousSha,
            head_branch: headBranch,
            head_repository: { full_name: headRepository },
            pull_requests: links,
          }),
        ],
      });

    if (accepted) {
      expect(collect()).toEqual({
        headSha: sha,
        evidenceHeadSha: previousSha,
        workflows: [
          expect.objectContaining({ name: "CI", id: 1, headSha: sha }),
          expect.objectContaining({ name: "Blacksmith ARM Testbox", id: 3, headSha: previousSha }),
        ],
      });
    } else {
      expect(collect).toThrow(
        `Missing successful recent Blacksmith ARM Testbox workflow for ${sha}`,
      );
    }
  });

  it("loads the complete PR commit set with one local rev-list command", () => {
    const baseSha = "a".repeat(40);
    const shas = Array.from({ length: 301 }, (_, index) =>
      (index + 1).toString(16).padStart(40, "0"),
    );
    const headSha = expectDefined(shas.at(-1), "generated head sha");
    const calls: string[][] = [];

    expect(
      loadPullRequestCommitShas({ baseSha, headSha }, (args) => {
        calls.push(args);
        return `${shas.join("\n")}\n`;
      }),
    ).toEqual(shas);
    expect(calls).toEqual([["rev-list", "--reverse", `${baseSha}..${headSha}`]]);
  });

  it.each([
    {
      name: "uppercase object id",
      output: `${"A".repeat(40)}\n`,
      error: "Expected pull request commit object ids from git rev-list.",
    },
    {
      name: "blank line",
      output: `${"a".repeat(40)}\n\n${"b".repeat(40)}\n`,
      error: "Expected pull request commit object ids from git rev-list.",
    },
    {
      name: "empty output",
      output: "",
      error: "Expected pull request commit object ids from git rev-list.",
    },
    {
      name: "missing head",
      output: `${"c".repeat(40)}\n`,
      error: `Expected pull request commit list to contain head ${"b".repeat(40)}.`,
    },
    {
      name: "command failure",
      output: new Error("git rev-list failed"),
      error: "git rev-list failed",
    },
  ])("rejects rev-list $name", ({ output, error }) => {
    expect(() =>
      loadPullRequestCommitShas({ baseSha: "a".repeat(40), headSha: "b".repeat(40) }, () => {
        if (output instanceof Error) {
          throw output;
        }
        return output;
      }),
    ).toThrow(output instanceof Error ? output : error);
  });

  it("keeps complete membership when the PR head is behind the current base", () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-pr-commit-set-")));
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: fixtureRoot, encoding: "utf8" });
      expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
      return result.stdout;
    };
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.name", "OpenClaw Test"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["commit", "-q", "--allow-empty", "-m", "root"]);
      git(["branch", "feature"]);
      git(["commit", "-q", "--allow-empty", "-m", "main one"]);
      git(["commit", "-q", "--allow-empty", "-m", "main two"]);
      const baseSha = git(["rev-parse", "HEAD"]).trim();
      git(["switch", "-q", "feature"]);
      git(["commit", "-q", "--allow-empty", "-m", "feature one"]);
      const firstFeatureSha = git(["rev-parse", "HEAD"]).trim();
      git(["commit", "-q", "--allow-empty", "-m", "feature two"]);
      const headSha = git(["rev-parse", "HEAD"]).trim();

      expect(loadPullRequestCommitShas({ baseSha, headSha }, (args) => git(args))).toEqual([
        firstFeatureSha,
        headSha,
      ]);
      expect(Number(git(["rev-list", "--count", `${headSha}..${baseSha}`]).trim())).toBe(2);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("requires recent evidence for scheduled gates observed on the target head", () => {
    const targetArmRun = successfulRun("Blacksmith ARM Testbox", 3, "2026-06-17T10:54:00Z", {
      status: "queued",
      conclusion: null,
    });
    const workflowRuns = [
      successfulRun("CI", 1, "2026-06-17T10:50:00Z", {
        head_sha: previousSha,
      }),
      successfulRun("CI", 2, "2026-06-17T10:54:00Z", {
        status: "in_progress",
        conclusion: null,
      }),
      targetArmRun,
    ];

    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns,
        ...patchReuseOptions(workflowRuns[0]),
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);

    const evidence = collectHostedGateEvidence({
      sha,
      recentSha: previousSha,
      workflowRuns: [
        ...workflowRuns,
        successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:51:00Z", {
          head_sha: previousSha,
        }),
      ],
      ...patchReuseOptions(workflowRuns[0]),
    });
    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", headSha: previousSha }),
      expect.objectContaining({ name: "Blacksmith ARM Testbox", headSha: previousSha }),
    ]);
    expect(evidence).toMatchObject({
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it("keeps the existing scheduled-workflow fallback after CI reuses another head", () => {
    const priorCiRun = priorSuccessfulCiRun({ id: 1 });
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        priorCiRun,
        successfulRun("CI", 2, "2026-06-17T10:54:00Z", {
          status: "in_progress",
          conclusion: null,
        }),
        successfulRun("Blacksmith ARM Testbox", 3, "2026-06-17T10:54:00Z", {
          status: "queued",
          conclusion: null,
        }),
        successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:53:00Z", {
          head_sha: scheduledFallbackSha,
        }),
      ],
      ...patchReuseOptions(priorCiRun),
    });

    expect(evidence).toMatchObject({
      headSha: sha,
      evidenceHeadSha: scheduledFallbackSha,
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
      workflows: [
        expect.objectContaining({ name: "CI", headSha: previousSha }),
        expect.objectContaining({
          name: "Blacksmith ARM Testbox",
          headSha: scheduledFallbackSha,
        }),
      ],
    });
  });

  it.each([
    {
      name: "13-hour evidence with a pending run",
      updatedAt: "2026-06-16T21:55:00Z",
      current: [pendingCiRun(2, "2026-06-17T10:54:00Z", "in_progress")],
    },
    {
      name: "failed scheduled run",
      updatedAt: "2026-06-17T10:50:00Z",
      current: [successfulRun("CI", 2, "2026-06-17T10:54:00Z", { conclusion: "failure" })],
    },
    {
      name: "skipped scheduled run",
      updatedAt: "2026-06-17T10:50:00Z",
      current: [successfulRun("CI", 2, "2026-06-17T10:54:00Z", { conclusion: "skipped" })],
    },
    {
      name: "failed manual gate",
      updatedAt: "2026-06-17T10:50:00Z",
      current: [
        pendingCiRun(2, "2026-06-17T10:53:00Z", "in_progress"),
        { ...releaseGateRun(3, "2026-06-17T10:54:00Z"), conclusion: "failure" },
      ],
    },
  ])("reuses patch-identical CI after $name", ({ updatedAt, current }) => {
    const priorRun = priorSuccessfulCiRun({ id: 1, updated_at: updatedAt });
    expect(
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [priorRun, ...current],
        ...patchReuseOptions(priorRun),
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it.each([
    { name: "failed", overrides: { conclusion: "failure" } },
    { name: "stale", overrides: { updated_at: "2026-06-16T10:54:59Z" } },
  ])("rejects a $name gate in the recorded head's cohort", ({ overrides }) => {
    const priorRun = priorSuccessfulCiRun({ id: 1, updated_at: "2026-06-17T10:50:00Z" });
    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [
          priorRun,
          successfulRun("Blacksmith ARM Testbox", 2, "2026-06-17T10:51:00Z", {
            head_sha: previousSha,
            ...overrides,
          }),
          pendingCiRun(3, "2026-06-17T10:54:00Z", "in_progress"),
          successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:54:00Z", {
            status: "queued",
            conclusion: null,
          }),
        ],
        ...patchReuseOptions(priorRun),
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);
  });

  it.each(["cancelled"])(
    "retains a recent scheduled success after a newer neutral run (%s)",
    (conclusion) => {
      const success = successfulRun("CI", 1, "2026-06-17T10:47:00Z");
      const neutral = { ...successfulRun("CI", 2, "2026-06-17T10:48:00Z"), conclusion };
      const collect = () => collectHostedGateEvidence({ sha, workflowRuns: [success, neutral] });
      expect(collect()).toEqual({
        headSha: sha,
        workflows: [expect.objectContaining({ name: "CI", id: 1 })],
      });
      for (const status of ["queued", "in_progress"]) {
        Object.assign(neutral, { status, conclusion: null });
        expect(collect).toThrow("Missing successful recent CI workflow");
      }
    },
  );

  it.each([
    ["stale scheduled CI", [successfulRun("CI", 1, "2026-06-16T10:54:59Z")]],
    ["stale manual CI", [releaseGateRun(2, "2026-06-16T10:54:59Z")]],
    [
      "skipped-only scheduled CI",
      [successfulRun("CI", 1, "2026-06-17T10:50:00Z", { conclusion: "skipped" })],
    ],
    [
      "in-progress over older manual",
      [
        releaseGateRun(1, "2026-06-17T10:49:00Z"),
        pendingCiRun(2, "2026-06-17T10:50:00Z", "in_progress"),
      ],
    ],
    [
      "pending over neutral and manual",
      [
        successfulRun("CI", 1, "2026-06-17T10:48:00Z", { conclusion: "skipped" }),
        releaseGateRun(2, "2026-06-17T10:49:00Z"),
        pendingCiRun(3, "2026-06-17T10:50:00Z"),
      ],
    ],
    [
      "newer failure despite inverted completion times",
      [
        successfulRun("CI", 1, "2026-06-17T10:54:00Z"),
        successfulRun("CI", 2, "2026-06-17T10:49:00Z", { conclusion: "failure" }),
      ],
    ],
    [
      "scheduled failure before manual fallback",
      [
        successfulRun("CI", 1, "2026-06-16T10:54:59Z", { conclusion: "failure" }),
        releaseGateRun(2, "2026-06-17T10:49:00Z"),
      ],
    ],
    [
      "scheduled failure before skipped run and fallback",
      [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z", { conclusion: "failure" }),
        successfulRun("CI", 2, "2026-06-17T10:48:00Z", { conclusion: "skipped" }),
        releaseGateRun(3, "2026-06-17T10:49:00Z"),
      ],
    ],
    [
      "scheduled failure before pending rerun and fallback",
      [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z", { conclusion: "failure" }),
        pendingCiRun(2, "2026-06-17T10:48:00Z", "in_progress"),
        releaseGateRun(3, "2026-06-17T10:49:00Z"),
      ],
    ],
    [
      "unmarked manual run",
      [{ ...releaseGateRun(1, "2026-06-17T10:47:00Z"), display_title: "CI" }],
    ],
    [
      "manual title on another workflow",
      [
        {
          ...releaseGateRun(1, "2026-06-17T10:47:00Z"),
          path: ".github/workflows/something-else.yml",
        },
      ],
    ],
  ] satisfies Array<[string, WorkflowRunFixture[]]>)("rejects %s", (_name, workflowRuns) => {
    expect(() => collectHostedGateEvidence({ sha, workflowRuns })).toThrow(
      `Missing successful recent CI workflow for ${sha}`,
    );
  });

  it("covers a queued artifact Testbox only with a completed exact CI fallback", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: queuedBuildArtifactFallbackRuns(),
      }),
    ).toEqual({
      headSha: sha,
      workflows: [
        expect.objectContaining({ name: "CI", id: 3 }),
        expect.objectContaining({ name: "Blacksmith Testbox", id: 4 }),
        expect.objectContaining({ name: "Blacksmith ARM Testbox", id: 5 }),
        expect.objectContaining({ name: "Workflow Sanity", id: 6 }),
      ],
      fallbackCoveredWorkflows: [
        {
          name: BUILD_ARTIFACTS_WORKFLOW,
          coveredBy: "CI release gate",
          reason: "scheduled workflow is queued",
        },
      ],
    });
  });

  it.each([
    ...(
      [
        ["release gate", 0],
        ["supporting gate", 4],
        ["queued artifact run", 5],
      ] satisfies Array<[string, number]>
    ).map(([name, staleIndex]) => ({
      name: `stale ${name}`,
      runs: queuedBuildArtifactFallbackRuns().map((run, index) =>
        index === staleIndex ? Object.assign({}, run, { updated_at: "2026-06-16T10:54:59Z" }) : run,
      ),
    })),
    {
      name: "an older failed artifact run",
      runs: [
        ...queuedBuildArtifactFallbackRuns(),
        successfulRun(BUILD_ARTIFACTS_WORKFLOW, 7, "2026-06-16T10:54:59Z", {
          conclusion: "failure",
        }),
      ],
    },
    {
      name: "missing supporting gates",
      runs: [
        releaseGateRun(1, "2026-06-17T10:49:00Z"),
        successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z", {
          status: "queued",
          conclusion: null,
        }),
      ],
    },
    ...[
      successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z", {
        status: "in_progress",
        conclusion: null,
      }),
      successfulRun(BUILD_ARTIFACTS_WORKFLOW, 3, "2026-06-17T10:51:00Z", { conclusion: "failure" }),
    ].map((run) => ({
      name: `artifact ${run.status}/${run.conclusion}`,
      runs: [releaseGateRun(1, "2026-06-17T10:49:00Z"), run],
    })),
    {
      name: "failure before a queued artifact retry",
      runs: [
        releaseGateRun(1, "2026-06-17T10:49:00Z"),
        successfulRun(BUILD_ARTIFACTS_WORKFLOW, 4, "2026-06-17T10:52:00Z", {
          conclusion: "failure",
        }),
        successfulRun(BUILD_ARTIFACTS_WORKFLOW, 5, "2026-06-17T10:53:00Z", {
          status: "queued",
          conclusion: null,
        }),
      ],
    },
  ])("rejects queued-artifact fallback with $name", ({ runs }) => {
    expect(() => collectHostedGateEvidence({ sha, workflowRuns: runs })).toThrow(
      "Missing successful recent Blacksmith Build Artifacts Testbox workflow",
    );
  });

  it("requires CI for docs unless the head changes only CHANGELOG.md", () => {
    expect(() => collectHostedGateEvidence({ sha, workflowRuns: [] })).toThrow(
      "Missing successful recent CI workflow",
    );
    expect(collectHostedGateEvidence({ sha, workflowRuns: [], changelogOnly: true })).toEqual({
      headSha: sha,
      workflows: [],
    });
  });

  it("parses required CLI arguments", () => {
    expect(parseArgs(requiredCliArgs)).toEqual({
      repo: "openclaw/openclaw",
      sha,
      mainSha,
      pr,
      recentSha: "",
      output: ".local/gates-hosted-checks.json",
      changelogOnly: false,
    });
    expect(() => parseArgs(["--repo", "openclaw/openclaw"])).toThrow("Usage:");
    expect(() => parseArgs(requiredCliArgs.with(1, "-h"))).toThrow("Expected --repo <value>.");
    expect(() => parseArgs(requiredCliArgs.with(3, "-h"))).toThrow("Expected --sha <value>.");
    expect(() => parseArgs(requiredCliArgs.with(5, "-h"))).toThrow("Expected --pr <value>.");
    for (const [value, expected] of [
      ["1", 1],
      ["001", 1],
      [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(parseArgs(requiredCliArgs.with(5, value)).pr).toBe(expected);
    }
    for (const value of [
      "zero",
      "0",
      String(Number.MAX_SAFE_INTEGER + 1),
      "1e3",
      "0x10",
      "0b10",
      "1.5",
      "+1",
      " 1 ",
    ]) {
      expect(() => parseArgs(requiredCliArgs.with(5, value))).toThrow(
        "Expected --pr <positive-integer>.",
      );
    }
    expect(() => parseArgs(requiredCliArgs.with(7, "-h"))).toThrow("Expected --output <value>.");
    expect(() => parseArgs(requiredCliArgs.with(9, "origin/main"))).toThrow("Usage:");
  });

  it("rejects malformed PR numbers before invoking GitHub", () => {
    const result = spawnSync(
      testNodeExecPath,
      [
        join(process.cwd(), "scripts/verify-pr-hosted-gates.mjs"),
        ...requiredCliArgs.with(5, "1e3"),
      ],
      { encoding: "utf8", env: { ...process.env, PATH: "" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected --pr <positive-integer>.");
    expect(result.stderr).not.toContain("spawnSync gh");
  });

  it.each([
    { number: pr + 1, repo: "openclaw/openclaw", head: sha, error: "does not identify" },
    { number: pr, repo: "replacement/openclaw", head: sha, error: "does not identify" },
    { number: pr, repo: "openclaw/openclaw", head: previousSha, error: "head changed" },
    { number: pr, repo: "openclaw/openclaw", head: "", error: "missing head metadata" },
  ])("rejects carried observation drift before hosted discovery: $number/$repo/$head", (value) => {
    expect(() =>
      main(requiredCliArgs, {
        number: value.number,
        baseRepository: { nameWithOwner: value.repo },
        headRefName: "topic",
        headRefOid: value.head,
        headRepository: { nameWithOwner: "openclaw/openclaw" },
      }),
    ).toThrow(value.error);
  });

  it("rejects duplicate hosted gate verifier CLI arguments", () => {
    const duplicateCases = [
      ["--repo", [...requiredCliArgs, "--repo", "fork/openclaw"]],
      ["--sha", [...requiredCliArgs, "--sha", "other-sha"]],
      ["--pr", [...requiredCliArgs, "--pr", "7"]],
      ["--recent-sha", [...requiredCliArgs, "--recent-sha", "one", "--recent-sha", "other"]],
      ["--output", [...requiredCliArgs, "--output", "two.json"]],
      ["--changelog-only", [...requiredCliArgs, "--changelog-only", "--changelog-only"]],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once.`);
    }
  });

  it("accepts one workflow-runs page emitted through a colorizing GitHub CLI shim", () => {
    expect(
      parseWorkflowRunPage(
        '\u001B[1;37m{"total_count":101,"workflow_runs":[{"id":1,"name":"CI"}]}\u001B[0m',
      ),
    ).toEqual({ totalCount: 101, workflowRuns: [{ id: 1, name: "CI" }] });
  });

  it.each([
    {
      name: "recorded pre-rebase SHA",
      recentSha: previousSha,
      headBranch: "",
      extra: `repos/openclaw/openclaw/actions/runs?head_sha=${previousSha}&per_page=30&page=1`,
    },
    {
      name: "encoded head branch",
      recentSha: "",
      headBranch: "codex/relax hosted gates",
      extra:
        "repos/openclaw/openclaw/actions/runs?branch=codex%2Frelax%20hosted%20gates&event=pull_request&per_page=30&page=1",
    },
  ])("queries the target and $name", ({ recentSha, headBranch, extra }) => {
    expect(workflowRunQueryPaths("openclaw/openclaw", { sha, recentSha, headBranch })).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=1`,
      extra,
    ]);
    expect(HOSTED_GATE_MAX_AGE_HOURS).toBe(24);
  });

  it("uses relay-safe pages and bounds pagination to GitHub's search result limit", () => {
    expect(workflowRunPageCount(0)).toBe(0);
    expect(workflowRunPageCount(101)).toBe(4);
    expect(workflowRunPageCount(10_000)).toBe(34);
    expect(workflowRunQueryPaths("openclaw/openclaw", { sha, recentSha: "" }, 34)).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=34`,
    ]);
  });
});

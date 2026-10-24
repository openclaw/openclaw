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
const ARM = "Blacksmith ARM Testbox";
const BOX = "Blacksmith Testbox";
const SANITY = "Workflow Sanity";
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";
const queuedArtifactCoverage = [
  {
    name: BUILD_ARTIFACTS_WORKFLOW,
    coveredBy: "CI release gate",
    reason: "scheduled workflow is queued",
  },
];
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
  run_attempt?: number;
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

function makeRun(
  name: string,
  id: number,
  updatedAt: string | number,
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
    updated_at:
      typeof updatedAt === "number"
        ? `2026-06-17T10:${String(updatedAt).padStart(2, "0")}:00Z`
        : updatedAt,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${id}`,
    ...overrides,
  };
}

function releaseGateRun(id: number, updatedAt: string | number) {
  return makeRun(`CI release gate ${sha}`, id, updatedAt, {
    event: "workflow_dispatch",
    display_title: `CI release gate ${sha}`,
  });
}

function pendingCiRun(id: number, updatedAt: string | number, status = "queued") {
  return makeRun("CI", id, updatedAt, { status, conclusion: null });
}

function queuedBuildArtifactFallbackRuns() {
  return [
    releaseGateRun(1, 49),
    makeRun("CI", 3, 51),
    makeRun(BOX, 4, 52),
    makeRun(ARM, 5, 53),
    makeRun(SANITY, 6, 54),
    makeRun(BUILD_ARTIFACTS_WORKFLOW, 2, 50, { status: "queued", conclusion: null }),
  ];
}

function collectHostedGateEvidence(
  workflowRuns: CollectHostedGateOptions["workflowRuns"],
  options: Omit<CollectHostedGateOptions, "nowMs" | "pr" | "mainSha" | "sha" | "workflowRuns"> & {
    sha?: string;
  } = {},
) {
  return collectHostedGateEvidenceRaw({ nowMs, pr, mainSha, sha, workflowRuns, ...options });
}

type GitExec = (args: string[], options?: { input?: string }) => string;
type CollectHostedGateOptions = Parameters<typeof collectHostedGateEvidenceRaw>[0];

function priorSuccessfulCiRun(overrides: Partial<WorkflowRunFixture> = {}): WorkflowRunFixture {
  return makeRun("CI", 101, "2026-06-17T09:55:00Z", { head_sha: previousSha, ...overrides });
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
  return { loadCiReuseCandidates: () => [candidate], execGit };
}
function reusedCiEvidence(id: number, fields: Record<string, unknown>) {
  return {
    headSha: sha,
    workflows: [expect.objectContaining({ id, ...fields })],
    reusedFromSha: previousSha,
    reusedRunId: id,
    patchIdMatched: true,
  };
}

function forkRun(overrides: Partial<WorkflowRunFixture>) {
  return {
    head_branch: "fix/token-listener",
    head_repository: { full_name: "contributor/openclaw" },
    pull_requests: [],
    ...overrides,
  };
}
const forkMembership = {
  pullRequestCommitShas: [previousSha, sha],
  pullRequestHeadBranch: "fix/token-listener",
  pullRequestHeadRepository: "contributor/openclaw",
};

function withGitRepository(prefix: string, check: (git: GitExec, root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git: GitExec = (args, options) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input: options?.input });
    expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };
  try {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "OpenClaw Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "commit.gpgSign", "false"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    check(git, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("verify-pr-hosted-gates", () => {
  it("compares patch IDs against one main snapshot while the shared ref advances", () => {
    withGitRepository("openclaw-patch-snapshot-", (git, root) => {
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
    });
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
        { cwd: targetRoot, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option: --older-cwd-startup-probe");
    } finally {
      rmSync(targetRoot, { force: true, recursive: true });
    }
  });

  it("derives hosted-gate applicability from declared workflow path filters", () => {
    expect(notApplicableScheduledHostedWorkflows([".github/workflows/ci.yml"])).toEqual([
      BOX,
      ARM,
      BUILD_ARTIFACTS_WORKFLOW,
    ]);
    expect(
      notApplicableScheduledHostedWorkflows([".github/actions/setup-node-env/action.yml"]),
    ).toEqual([]);
    expect(
      notApplicableScheduledHostedWorkflows(["test/e2e/qa-lab/runtime/script-evidence.ts"]),
    ).toEqual([BOX, ARM, BUILD_ARTIFACTS_WORKFLOW]);
    expect(notApplicableScheduledHostedWorkflows(["CHANGELOG.md"])).toEqual(
      SCHEDULED_HOSTED_WORKFLOWS,
    );
  });

  it("requires an authoritative ARM run when declared workflow paths apply", () => {
    const workflowRuns = [
      makeRun("CI", 1, 47),
      makeRun(BOX, 2, 48),
      makeRun(BUILD_ARTIFACTS_WORKFLOW, 3, 49),
      makeRun(SANITY, 4, 50),
    ];

    expect(() =>
      collectHostedGateEvidence(workflowRuns, { notApplicableScheduledWorkflows: [] }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${sha}`);
  });

  it("records path-filtered hosted gates as not applicable for QA-only changes", () => {
    const evidence = collectHostedGateEvidence(
      [
        makeRun("CI", 1, "2026-06-17T10:47:00Z"),
        makeRun("Workflow Sanity", 2, "2026-06-17T10:48:00Z"),
      ],
      {
        notApplicableScheduledWorkflows: [
          "Blacksmith Testbox",
          "Blacksmith ARM Testbox",
          "Blacksmith Build Artifacts Testbox",
        ],
      },
    );

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
    const workflowRuns = queuedBuildArtifactFallbackRuns().filter((run) => run.name !== ARM);
    const evidence = collectHostedGateEvidence(workflowRuns, {
      notApplicableScheduledWorkflows: [ARM],
    });

    expect(evidence.fallbackCoveredWorkflows).toEqual(queuedArtifactCoverage);
    expect(evidence.notApplicableWorkflows).toEqual([ARM]);
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
        collectHostedGateEvidence([], { ...patchReuseOptions(priorSuccessfulCiRun(), execGit) }),
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
      collectHostedGateEvidence([], {
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
    expect(collectHostedGateEvidence([], { ...patchReuseOptions(candidate) })).toEqual(
      reusedCiEvidence(102, { event: "workflow_dispatch" }),
    );
  });

  it("short-circuits reuse discovery when exact-head CI already succeeds", () => {
    let reuseCalled = false;
    const evidence = collectHostedGateEvidence([makeRun("CI", 1, 47)], {
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

  it.each([
    { earlierFailure: false, attempt: 2 },
    { earlierFailure: true, attempt: 1 },
  ])(
    "accepts only current-attempt gate proof for pending CI (earlier failure: $earlierFailure)",
    ({ earlierFailure, attempt }) => {
      const failedRun = makeRun("CI", 40, 40, { conclusion: "failure" });
      const inProgressRun = makeRun("CI", 42, 52, {
        status: "in_progress",
        conclusion: null,
        run_attempt: attempt,
        created_at: "2026-06-17T10:50:00Z",
      });
      const workflowRuns = earlierFailure ? [failedRun, inProgressRun] : [inProgressRun];
      const gateJob = {
        name: "openclaw/ci-gate",
        run_id: 42,
        run_attempt: attempt,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-17T10:51:30Z",
      };

      const evidence = collectHostedGateEvidence(workflowRuns, { ciGateJobs: [gateJob] });
      expect(evidence.workflows.map((workflow: { id: unknown }) => workflow.id)).toContain(42);

      for (const ciGateJobs of [
        [{ ...gateJob, run_attempt: attempt - 1 }],
        [{ ...gateJob, run_id: 41 }],
        [{ ...gateJob, conclusion: "failure" }],
        [],
      ]) {
        expect(() => collectHostedGateEvidence(workflowRuns, { ciGateJobs })).toThrow(
          /Missing successful recent CI workflow/,
        );
      }
      if (earlierFailure) {
        expect(() => collectHostedGateEvidence([failedRun], { ciGateJobs: [gateJob] })).toThrow(
          /Missing successful recent CI workflow/,
        );
        expect(() =>
          collectHostedGateEvidence(
            [failedRun, { ...inProgressRun, created_at: "2026-06-17T10:40:00Z" }],
            { ciGateJobs: [gateJob] },
          ),
        ).toThrow(/Missing successful recent CI workflow/);
      }
    },
  );

  it.each([ARM])("retains the newest non-skipped %s decision by creation order", (workflowName) => {
    const evidence = collectHostedGateEvidence([
      makeRun("CI", 1, 47),
      makeRun(workflowName, 10, 54),
      makeRun(workflowName, 20, 53),
      makeRun(workflowName, 30, 50, { conclusion: "skipped" }),
    ]);

    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", id: 1 }),
      expect.objectContaining({ name: workflowName, id: 20 }),
    ]);
  });

  it.each([ARM])(
    "covers queued artifacts after a skipped duplicate of supporting %s",
    (workflowName) => {
      const workflowRuns = queuedBuildArtifactFallbackRuns();
      const supportingRun = expectDefined(
        workflowRuns.find((run) => run.name === workflowName),
        "successful supporting workflow",
      );
      const evidence = collectHostedGateEvidence([
        ...workflowRuns,
        makeRun(workflowName, 4, 54),
        makeRun(workflowName, 30, 50, { conclusion: "skipped" }),
      ]);

      expect(evidence).toEqual({
        headSha: sha,
        workflows: [
          expect.objectContaining({ name: "CI", id: 3 }),
          expect.objectContaining({ name: BOX, id: 4 }),
          expect.objectContaining({ name: workflowName, id: supportingRun.id }),
          expect.objectContaining({ name: SANITY, id: 6 }),
        ],
        fallbackCoveredWorkflows: queuedArtifactCoverage,
      });
    },
  );

  it.each([ARM])("does not look past a non-skipped unsuccessful %s decision", (workflowName) => {
    for (const [status, conclusion] of [
      ["completed", "failure"],
      ["completed", null],
      ["queued", null],
      ["in_progress", "skipped"],
    ] as const) {
      expect(
        () =>
          collectHostedGateEvidence([
            makeRun("CI", 1, 47),
            makeRun(workflowName, 10, 54),
            makeRun(workflowName, 20, 53, { run_attempt: 2, status, conclusion }),
            makeRun(workflowName, 30, 50, { conclusion: "skipped" }),
          ]),
        `${status}/${conclusion}`,
      ).toThrow(`Missing successful recent ${workflowName} workflow`);
    }
  });

  it.each([ARM])(
    "requires eligible recent %s success before a skipped duplicate",
    (workflowName) => {
      const success = makeRun(workflowName, 10, 54);
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
            collectHostedGateEvidence([
              makeRun("CI", 1, 47),
              ...earlierRuns,
              makeRun(workflowName, 30, 50, { conclusion: "skipped" }),
            ]),
          label,
        ).toThrow(`Missing successful recent ${workflowName} workflow`);
      }
    },
  );

  it("requires the latest scheduled workflow run to pass", () => {
    const evidence = collectHostedGateEvidence([
      makeRun("CI", 1, 47),
      makeRun(BOX, 2, "2026-06-17T10:47:30Z", { event: "workflow_dispatch" }),
      makeRun(BOX, 3, 48),
      makeRun(ARM, 4, 49),
      makeRun(BUILD_ARTIFACTS_WORKFLOW, 5, 50),
      makeRun(SANITY, 6, 51),
    ]);

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [
        expect.objectContaining({ name: "CI", id: 1 }),
        expect.objectContaining({ name: BOX, id: 3 }),
        expect.objectContaining({ name: ARM, id: 4 }),
        expect.objectContaining({ name: BUILD_ARTIFACTS_WORKFLOW, id: 5 }),
        expect.objectContaining({ name: SANITY, id: 6 }),
      ],
    });
  });

  it("rejects a failed rerun of a workflow that was scheduled for the exact head", () => {
    const workflowRuns = ["CI", ...SCHEDULED_HOSTED_WORKFLOWS].map((name, index) =>
      makeRun(name, index + 1, `2026-06-17T10:4${index}:00Z`),
    );
    workflowRuns[2] = {
      ...expectDefined(workflowRuns[2], "Blacksmith ARM Testbox workflow run"),
      conclusion: "failure",
      updated_at: "2026-06-17T10:50:00Z",
    };

    expect(() => collectHostedGateEvidence(workflowRuns)).toThrow(
      "Missing successful recent Blacksmith ARM Testbox workflow",
    );
  });

  it.each([
    [
      "scheduled CI at the age boundary",
      [makeRun("CI", 1, "2026-06-16T10:55:00Z")],
      { name: "CI", id: 1 },
    ],
    ["changelog-only head without CI", [], undefined, true],
    [
      "manual CI at the age boundary",
      [
        makeRun(`CI release gate ${sha}`, 1, "2026-06-16T10:55:00Z", {
          event: "workflow_dispatch",
          path: ".github/workflows/ci.yml@refs/heads/release-controls",
          display_title: `CI release gate ${sha}`,
        }),
      ],
      { name: `CI release gate ${sha}`, id: 1 },
    ],
    [
      "later success after failure",
      [makeRun("CI", 1, 50, { conclusion: "failure" }), makeRun("CI", 2, 52)],
      { name: "CI", id: 2, headSha: sha },
    ],
    [
      "target success before obsolete-head failure",
      [
        makeRun("CI", 1, 50),
        makeRun("CI", 2, 54, { head_sha: previousSha, conclusion: "failure" }),
      ],
      { name: "CI", id: 1, headSha: sha },
    ],
    ...(
      [
        ["stale", makeRun("CI", 1, "2026-06-16T10:54:59Z")],
        ["cancelled", makeRun("CI", 1, 50, { conclusion: "cancelled" })],
        ["skipped", makeRun("CI", 1, 50, { conclusion: "skipped" })],
      ] satisfies Array<[string, WorkflowRunFixture]>
    ).map(([state, run]): [string, WorkflowRunFixture[], { name: string; id: number }] => [
      `manual fallback after ${state}`,
      [run, releaseGateRun(2, 49)],
      { name: `CI release gate ${sha}`, id: 2 },
    ]),
    [
      "newer manual over older pending",
      [pendingCiRun(1, 48, "in_progress"), releaseGateRun(2, 49)],
      { name: `CI release gate ${sha}`, id: 2 },
    ],
  ] satisfies Array<
    [string, WorkflowRunFixture[], { name: string; id: number; headSha?: string }?, boolean?]
  >)(
    "selects %s",
    (
      _name,
      runs,
      selected?: { name: string; id: number; headSha?: string },
      changelogOnly?: boolean,
    ) => {
      expect(collectHostedGateEvidence(runs, { changelogOnly })).toEqual({
        headSha: sha,
        workflows: selected ? [expect.objectContaining(selected)] : [],
      });
    },
  );

  it("accepts a recent green fork head when GitHub omits pull request links", () => {
    const priorRun = makeRun("CI", 1, 50, forkRun({ head_sha: previousSha }));
    const evidence = collectHostedGateEvidence(
      [priorRun, makeRun("CI", 2, 54, forkRun({ conclusion: "failure" }))],
      {
        ...forkMembership,
        ...patchReuseOptions(priorRun),
      },
    );

    expect(evidence).toEqual(reusedCiEvidence(1, { name: "CI", headSha: previousSha }));
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
    const collect = () =>
      collectHostedGateEvidence(
        [
          makeRun("CI", 1, 50),
          makeRun(ARM, 2, 54, { status: "queued", conclusion: null }),
          makeRun(ARM, 3, 53, forkRun({ head_sha: previousSha, pull_requests: links })),
        ],
        {
          ...forkMembership,
          pullRequestCommitShas: commits,
        },
      );

    if (accepted) {
      expect(collect()).toEqual({
        headSha: sha,
        workflows: [
          expect.objectContaining({ name: "CI", id: 1, headSha: sha }),
          expect.objectContaining({ name: ARM, id: 3, headSha: previousSha }),
        ],
        evidenceHeadSha: previousSha,
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
    ["uppercase object id", `${"A".repeat(40)}\n`],
    ["empty output", ""],
    [
      "missing head",
      `${"c".repeat(40)}\n`,
      `Expected pull request commit list to contain head ${"b".repeat(40)}.`,
    ],
    ["command failure", new Error("git rev-list failed")],
  ] satisfies Array<[string, string | Error, string?]>)(
    "rejects rev-list %s",
    (_name, output, error?: string) => {
      expect(() =>
        loadPullRequestCommitShas({ baseSha: "a".repeat(40), headSha: "b".repeat(40) }, () => {
          if (output instanceof Error) {
            throw output;
          }
          return output;
        }),
      ).toThrow(
        output instanceof Error
          ? output
          : (error ?? "Expected pull request commit object ids from git rev-list."),
      );
    },
  );

  it("keeps complete membership when the PR head is behind the current base", () => {
    withGitRepository("openclaw-pr-commit-set-", (git) => {
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
    });
  });

  it("requires recent evidence for scheduled gates observed on the target head", () => {
    const targetArmRun = makeRun(ARM, 3, 54, { status: "queued", conclusion: null });
    const workflowRuns = [
      makeRun("CI", 1, 50, { head_sha: previousSha }),
      makeRun("CI", 2, 54, { status: "in_progress", conclusion: null }),
      targetArmRun,
    ];

    expect(() =>
      collectHostedGateEvidence(workflowRuns, {
        recentSha: previousSha,
        ...patchReuseOptions(workflowRuns[0]),
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);

    const evidence = collectHostedGateEvidence(
      [...workflowRuns, makeRun(ARM, 4, 51, { head_sha: previousSha })],
      { recentSha: previousSha, ...patchReuseOptions(workflowRuns[0]) },
    );
    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", headSha: previousSha }),
      expect.objectContaining({ name: ARM, headSha: previousSha }),
    ]);
    expect(evidence).toMatchObject({
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it("keeps the existing scheduled-workflow fallback after CI reuses another head", () => {
    const priorCiRun = priorSuccessfulCiRun({ id: 1 });
    const evidence = collectHostedGateEvidence(
      [
        priorCiRun,
        makeRun("CI", 2, 54, { status: "in_progress", conclusion: null }),
        makeRun(ARM, 3, 54, { status: "queued", conclusion: null }),
        makeRun(ARM, 4, 53, { head_sha: scheduledFallbackSha }),
      ],
      { ...patchReuseOptions(priorCiRun) },
    );

    expect(evidence).toMatchObject({
      headSha: sha,
      workflows: [
        expect.objectContaining({ name: "CI", headSha: previousSha }),
        expect.objectContaining({ name: ARM, headSha: scheduledFallbackSha }),
      ],
      evidenceHeadSha: scheduledFallbackSha,
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it.each([
    [
      "13-hour evidence with a pending run",
      [pendingCiRun(2, 54, "in_progress")],
      "2026-06-16T21:55:00Z",
    ],
    ["failed scheduled run", [makeRun("CI", 2, 54, { conclusion: "failure" })]],
    ["skipped scheduled run", [makeRun("CI", 2, 54, { conclusion: "skipped" })]],
    [
      "failed manual gate",
      [pendingCiRun(2, 53, "in_progress"), { ...releaseGateRun(3, 54), conclusion: "failure" }],
    ],
  ] satisfies Array<[string, WorkflowRunFixture[], string?]>)(
    "reuses patch-identical CI after %s",
    (_name, current, updatedAt = "2026-06-17T10:50:00Z") => {
      const priorRun = priorSuccessfulCiRun({ id: 1, updated_at: updatedAt });
      expect(
        collectHostedGateEvidence([priorRun, ...current], {
          recentSha: previousSha,
          ...patchReuseOptions(priorRun),
        }),
      ).toEqual(reusedCiEvidence(1, { name: "CI", headSha: previousSha }));
    },
  );

  it.each([
    { name: "failed", overrides: { conclusion: "failure" } },
    { name: "stale", overrides: { updated_at: "2026-06-16T10:54:59Z" } },
  ])("rejects a $name gate in the recorded head's cohort", ({ overrides }) => {
    const priorRun = priorSuccessfulCiRun({ id: 1, updated_at: "2026-06-17T10:50:00Z" });
    expect(() =>
      collectHostedGateEvidence(
        [
          priorRun,
          makeRun(ARM, 2, 51, { head_sha: previousSha, ...overrides }),
          pendingCiRun(3, 54, "in_progress"),
          makeRun(ARM, 4, 54, { status: "queued", conclusion: null }),
        ],
        { recentSha: previousSha, ...patchReuseOptions(priorRun) },
      ),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);
  });

  it.each(["cancelled"])(
    "retains a recent scheduled success after a newer neutral run (%s)",
    (conclusion) => {
      const success = makeRun("CI", 1, 47);
      const neutral = makeRun("CI", 2, 48, { conclusion });
      const collect = () => collectHostedGateEvidence([success, neutral]);
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
    ["missing CI", []],
    ["stale scheduled CI", [makeRun("CI", 1, "2026-06-16T10:54:59Z")]],
    ["stale manual CI", [releaseGateRun(2, "2026-06-16T10:54:59Z")]],
    ["skipped-only scheduled CI", [makeRun("CI", 1, 50, { conclusion: "skipped" })]],
    ["in-progress over older manual", [releaseGateRun(1, 49), pendingCiRun(2, 50, "in_progress")]],
    [
      "pending over neutral and manual",
      [makeRun("CI", 1, 48, { conclusion: "skipped" }), releaseGateRun(2, 49), pendingCiRun(3, 50)],
    ],
    [
      "newer failure despite inverted completion times",
      [makeRun("CI", 1, 54), makeRun("CI", 2, 49, { conclusion: "failure" })],
    ],
    [
      "scheduled failure before manual fallback",
      [makeRun("CI", 1, "2026-06-16T10:54:59Z", { conclusion: "failure" }), releaseGateRun(2, 49)],
    ],
    [
      "scheduled failure before skipped run and fallback",
      [
        makeRun("CI", 1, 47, { conclusion: "failure" }),
        makeRun("CI", 2, 48, { conclusion: "skipped" }),
        releaseGateRun(3, 49),
      ],
    ],
    [
      "scheduled failure before pending rerun and fallback",
      [
        makeRun("CI", 1, 47, { conclusion: "failure" }),
        pendingCiRun(2, 48, "in_progress"),
        releaseGateRun(3, 49),
      ],
    ],
    ["unmarked manual run", [{ ...releaseGateRun(1, 47), display_title: "CI" }]],
    [
      "manual title on another workflow",
      [{ ...releaseGateRun(1, 47), path: ".github/workflows/something-else.yml" }],
    ],
  ] satisfies Array<[string, WorkflowRunFixture[]]>)("rejects %s", (_name, workflowRuns) => {
    expect(() => collectHostedGateEvidence(workflowRuns)).toThrow(
      `Missing successful recent CI workflow for ${sha}`,
    );
  });

  it.each([
    ...[0, 30].map((id) => ({
      name: `skipped artifact history at run ${id}`,
      runs: [
        ...queuedBuildArtifactFallbackRuns(),
        makeRun(BUILD_ARTIFACTS_WORKFLOW, id, 50, { conclusion: "skipped" }),
      ],
    })),
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
        ...queuedBuildArtifactFallbackRuns().map((run) =>
          Object.assign({}, run, { id: run.id + 1, run_number: run.run_number + 1 }),
        ),
        makeRun(BUILD_ARTIFACTS_WORKFLOW, 1, "2026-06-16T10:54:59Z", { conclusion: "failure" }),
      ],
    },
    {
      name: "missing supporting gates",
      runs: [
        releaseGateRun(1, 49),
        makeRun(BUILD_ARTIFACTS_WORKFLOW, 2, 50, { status: "queued", conclusion: null }),
      ],
    },
    ...[
      makeRun(BUILD_ARTIFACTS_WORKFLOW, 2, 50, { status: "in_progress", conclusion: null }),
      makeRun(BUILD_ARTIFACTS_WORKFLOW, 3, 51, { conclusion: "failure" }),
    ].map((run) => ({
      name: `artifact ${run.status}/${run.conclusion}`,
      runs: [releaseGateRun(1, 49), run],
    })),
    {
      name: "failure before a queued artifact retry",
      runs: [
        releaseGateRun(1, 49),
        makeRun(BUILD_ARTIFACTS_WORKFLOW, 4, 52, { conclusion: "failure" }),
        makeRun(BUILD_ARTIFACTS_WORKFLOW, 5, 53, { status: "queued", conclusion: null }),
      ],
    },
  ])("rejects queued-artifact fallback with $name", ({ runs }) => {
    expect(() => collectHostedGateEvidence(runs)).toThrow(
      "Missing successful recent Blacksmith Build Artifacts Testbox workflow",
    );
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

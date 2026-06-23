import { describe, expect, it } from "vitest";
import {
  collectHostedGateEvidence,
  parseArgs,
  parseWorkflowRunPages,
  SCHEDULED_HOSTED_WORKFLOWS,
} from "../../scripts/verify-pr-hosted-gates.mjs";

const sha = "773ffd87a1e1e34451ad6e38fda37380c2569a50";
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";

function successfulRun(name: string, id: number, updatedAt: string) {
  return {
    id,
    name,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    path: ".github/workflows/ci.yml",
    created_at: "2026-06-17T10:46:24Z",
    updated_at: updatedAt,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${id}`,
  };
}

describe("verify-pr-hosted-gates", () => {
  it("requires the latest scheduled workflow run to pass", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
        {
          ...successfulRun("Blacksmith Testbox", 2, "2026-06-17T10:47:30Z"),
          event: "workflow_dispatch",
        },
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
      ...workflowRuns[2],
      conclusion: "failure",
      updated_at: "2026-06-17T10:50:00Z",
    };

    expect(() => collectHostedGateEvidence({ sha, workflowRuns })).toThrow(
      "Missing successful exact-head Blacksmith ARM Testbox workflow",
    );
  });

  it("accepts a non-docs PR when CI is the only scheduled authoritative workflow", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [successfulRun("CI", 1, "2026-06-17T10:47:00Z")],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1 })],
    });
  });

  it("uses the latest CI run when an older duplicate was cancelled", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
            conclusion: "cancelled",
          },
          successfulRun("CI", 2, "2026-06-17T10:48:00Z"),
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 2 })],
    });
  });

  it("accepts the explicit exact-SHA manual CI release gate", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:47:00Z"),
            event: "workflow_dispatch",
            path: ".github/workflows/ci.yml@refs/heads/release-controls",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: `CI release gate ${sha}`, id: 1 })],
    });
  });

  it("prefers the exact release-gate fallback while scheduled CI remains queued", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
            status: "queued",
            conclusion: null,
            updated_at: "2026-06-17T10:50:00Z",
          },
          {
            ...successfulRun(`CI release gate ${sha}`, 2, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: `CI release gate ${sha}`, id: 2 })],
    });
  });

  it("rejects a completed scheduled CI failure even when a fallback passed", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            conclusion: "failure",
          },
          {
            ...successfulRun(`CI release gate ${sha}`, 2, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toThrow("Missing successful exact-head CI workflow");
  });

  it("covers a queued artifact Testbox only with a completed exact CI fallback", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
          successfulRun("CI", 3, "2026-06-17T10:51:00Z"),
          successfulRun("Blacksmith Testbox", 4, "2026-06-17T10:52:00Z"),
          successfulRun("Blacksmith ARM Testbox", 5, "2026-06-17T10:53:00Z"),
          successfulRun("Workflow Sanity", 6, "2026-06-17T10:54:00Z"),
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
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

  it("does not cover queued artifacts until all supporting workflow gates pass", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
      }),
    ).toThrow("Missing successful exact-head Blacksmith Build Artifacts Testbox workflow");
  });

  it("keeps active or terminal non-successful artifact Testboxes blocking", () => {
    const ciFallback = {
      ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:49:00Z"),
      event: "workflow_dispatch",
      display_title: `CI release gate ${sha}`,
    };

    for (const artifactRun of [
      {
        ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z"),
        status: "in_progress",
        conclusion: null,
      },
      {
        ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 3, "2026-06-17T10:51:00Z"),
        conclusion: "failure",
      },
    ]) {
      expect(() =>
        collectHostedGateEvidence({
          sha,
          workflowRuns: [ciFallback, artifactRun],
        }),
      ).toThrow("Missing successful exact-head Blacksmith Build Artifacts Testbox workflow");
    }

    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          ciFallback,
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 4, "2026-06-17T10:52:00Z"),
            conclusion: "failure",
          },
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 5, "2026-06-17T10:53:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
      }),
    ).toThrow("Missing successful exact-head Blacksmith Build Artifacts Testbox workflow");
  });

  it("rejects an unmarked manual CI run", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:47:00Z"),
            event: "workflow_dispatch",
            display_title: "CI",
          },
        ],
      }),
    ).toThrow("Missing successful exact-head CI workflow");
  });

  it("rejects a manual release-gate title from another workflow", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:47:00Z"),
            event: "workflow_dispatch",
            path: ".github/workflows/something-else.yml",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toThrow("Missing successful exact-head CI workflow");
  });

  it("requires CI for docs unless the head changes only CHANGELOG.md", () => {
    expect(() => collectHostedGateEvidence({ sha, workflowRuns: [] })).toThrow(
      "Missing successful exact-head CI workflow",
    );
    expect(collectHostedGateEvidence({ sha, workflowRuns: [], changelogOnly: true })).toEqual({
      headSha: sha,
      workflows: [],
    });
  });

  it("parses required CLI arguments", () => {
    expect(
      parseArgs([
        "--repo",
        "openclaw/openclaw",
        "--sha",
        sha,
        "--output",
        ".local/gates-hosted-checks.json",
      ]),
    ).toEqual({
      repo: "openclaw/openclaw",
      sha,
      output: ".local/gates-hosted-checks.json",
      changelogOnly: false,
    });
    expect(() => parseArgs(["--repo", "openclaw/openclaw"])).toThrow("Usage:");
    expect(() =>
      parseArgs(["--repo", "-h", "--sha", sha, "--output", ".local/gates-hosted-checks.json"]),
    ).toThrow("Expected --repo <value>.");
    expect(() =>
      parseArgs([
        "--repo",
        "openclaw/openclaw",
        "--sha",
        "-h",
        "--output",
        ".local/gates-hosted-checks.json",
      ]),
    ).toThrow("Expected --sha <value>.");
    expect(() =>
      parseArgs(["--repo", "openclaw/openclaw", "--sha", sha, "--output", "-h"]),
    ).toThrow("Expected --output <value>.");
  });

  it("accepts JSON emitted through a colorizing GitHub CLI shim", () => {
    expect(
      parseWorkflowRunPages('\u001B[1;37m[{"workflow_runs":[{"id":1,"name":"CI"}]}]\u001B[0m'),
    ).toEqual([{ id: 1, name: "CI" }]);
  });
});

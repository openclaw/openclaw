import { describe, expect, it } from "vitest";
import { chooseReadyBacklogIssue, summarizeOperatorTicket } from "./harness.js";
import type { LinearIssueRef, ManagedIssueGroup, OperatorReviewRole, TaskPacket } from "./types.js";

function makeTaskPacket(role: TaskPacket["role"]): TaskPacket {
  return {
    kind: "task",
    contractId: "generic",
    externalTicketId: "END-100",
    role,
    summary: `${role} task`,
    upstreamUrl: "https://linear.app/example/issue/END-100",
    startupCommand: "pnpm dev",
    healthcheckUrl: "http://127.0.0.1:3000",
    browserWalkthrough: [],
    requiredArtifacts: ["before.png"],
    artifactDir: `/tmp/${role}`,
    repoRelativeArtifactDir: `operator-harness/evidence/END-100/${role}`,
    repoCwd: "/tmp/repo",
    branchName: "codex/end-100",
    baseBranch: "main",
    gitRemoteName: "origin",
    prRequired: true,
    prTitle: "[END-100] Example",
    prBodyPath: "/tmp/repo/.openclaw-operator/pr-body.md",
    notionUrls: [],
    acceptanceCriteria: [],
    relevantScreens: [],
  };
}

function makeGroup(
  overrides: {
    builderStatus?: string;
    reviewRoles?: OperatorReviewRole[];
    reviewStatuses?: Partial<Record<OperatorReviewRole, string>>;
    spotCheckStatus?: string;
    parentStatus?: string;
  } = {},
): ManagedIssueGroup {
  const reviewRoles = overrides.reviewRoles ?? ["qa", "ux"];
  return {
    parent: {
      id: "parent-1",
      identifier: "OPE-1",
      title: "[END-100] Example",
      description: null,
      status: overrides.parentStatus ?? "todo",
      priority: "high",
      parentId: null,
      projectId: "project-1",
      assigneeAgentId: null,
      executionRunId: null,
      updatedAt: "2026-03-10T00:00:00.000Z",
      activeRun: null,
    },
    specPacket: {
      kind: "parent",
      contractId: "generic",
      externalTicketId: "END-100",
      upstreamIssueId: "linear-1",
      title: "Example",
      summary: "Example summary",
      upstreamUrl: "https://linear.app/example/issue/END-100",
      notionUrls: [],
      storyboardHubUrls: [],
      acceptanceCriteria: [],
      startupCommand: "pnpm dev",
      healthcheckUrl: "http://127.0.0.1:3000",
      browserWalkthrough: [],
      requiredArtifacts: ["before.png"],
      requiredReviewRoles: reviewRoles,
      relevantScreens: [],
      notionPages: [],
      repoKey: "openclaw",
      repoName: "OpenClaw",
      repoCwd: "/tmp/repo",
      repoUrl: "https://github.com/openclaw/openclaw",
      baseBranch: "main",
      environmentPrerequisites: [],
    },
    subtasks: [
      {
        id: "builder-1",
        identifier: "OPE-2",
        title: "Implement END-100",
        description: null,
        status: overrides.builderStatus ?? "done",
        priority: "high",
        parentId: "parent-1",
        projectId: "project-1",
        assigneeAgentId: "agent-builder",
        executionRunId: null,
        updatedAt: "2026-03-10T00:00:00.000Z",
        activeRun: null,
        taskPacket: makeTaskPacket("builder"),
      },
      ...reviewRoles.flatMap((role) =>
        overrides.reviewStatuses?.[role]
          ? [
              {
                id: `${role}-1`,
                identifier: `OPE-${role}`,
                title: `${role} review`,
                description: null,
                status: overrides.reviewStatuses[role],
                priority: "medium",
                parentId: "parent-1",
                projectId: "project-1",
                assigneeAgentId: `agent-${role}`,
                executionRunId: null,
                updatedAt: "2026-03-10T00:00:00.000Z",
                activeRun: null,
                taskPacket: makeTaskPacket(role),
              },
            ]
          : [],
      ),
      ...(overrides.spotCheckStatus
        ? [
            {
              id: "spot-check-1",
              identifier: "OPE-spot",
              title: "spot-check",
              description: null,
              status: overrides.spotCheckStatus,
              priority: "medium",
              parentId: "parent-1",
              projectId: "project-1",
              assigneeAgentId: null,
              executionRunId: null,
              updatedAt: "2026-03-10T00:00:00.000Z",
              activeRun: null,
              taskPacket: makeTaskPacket("spot-check"),
            },
          ]
        : []),
    ],
  };
}

describe("summarizeOperatorTicket", () => {
  it("flags finished builder work without review subtasks as review-needed", () => {
    const group = makeGroup();
    const ticket = summarizeOperatorTicket(group);
    expect(ticket.lifecycle).toBe("review-needed");
    expect(ticket.missingReviewRoles).toEqual(["qa", "ux"]);
    expect(ticket.reviewRequested).toBe(false);
  });

  it("flags review-complete work without spot-check evidence as spot-check-needed", () => {
    const group = makeGroup({
      reviewStatuses: {
        qa: "done",
        ux: "done",
      },
    });
    const ticket = summarizeOperatorTicket(group);
    expect(ticket.lifecycle).toBe("spot-check-needed");
    expect(ticket.spotCheckNeeded).toBe(true);
  });

  it("marks a ticket done when reviews and spot-check are complete", () => {
    const group = makeGroup({
      reviewStatuses: {
        qa: "done",
        ux: "done",
      },
      spotCheckStatus: "done",
      parentStatus: "done",
    });
    const ticket = summarizeOperatorTicket(group);
    expect(ticket.lifecycle).toBe("done");
    expect(ticket.spotCheckStatus).toBe("done");
  });
});

describe("chooseReadyBacklogIssue", () => {
  function issue(
    input: Partial<LinearIssueRef> & Pick<LinearIssueRef, "identifier" | "title">,
  ): LinearIssueRef {
    return {
      id: input.id ?? input.identifier,
      identifier: input.identifier,
      title: input.title,
      description: input.description ?? "",
      url: input.url ?? `https://linear.example/${input.identifier}`,
      priority: input.priority ?? 0,
      state: input.state ?? { id: "todo", name: "Todo", type: "unstarted" },
      labels: input.labels ?? [],
      projectName: input.projectName ?? null,
      createdAt: input.createdAt ?? "2026-03-10T00:00:00.000Z",
      updatedAt: input.updatedAt ?? "2026-03-10T00:00:00.000Z",
    };
  }

  it("prefers configured project tickets over higher-priority harness work", () => {
    const selected = chooseReadyBacklogIssue(
      [
        issue({
          identifier: "END-5",
          title: "Harness plumbing",
          priority: 2,
        }),
        issue({
          identifier: "END-7",
          title: "Pilot shell and parcel intake on clean main",
          projectName: "Moore Bass Pilot: Discovery-First DD",
          priority: 0,
          createdAt: "2026-03-09T00:00:00.000Z",
        }),
      ],
      {
        teamKey: "END",
        readyStateTypes: ["unstarted"],
        readyStateNames: ["Todo", "Backlog"],
        preferredProjectNames: ["Moore Bass Pilot: Discovery-First DD"],
      },
      new Set(),
    );

    expect(selected?.identifier).toBe("END-7");
  });

  it("excludes configured project names from the candidate set", () => {
    const selected = chooseReadyBacklogIssue(
      [
        issue({
          identifier: "END-5",
          title: "Harness plumbing",
          projectName: "Operator Harness",
          priority: 2,
        }),
        issue({
          identifier: "END-7",
          title: "Pilot shell and parcel intake on clean main",
          projectName: "Moore Bass Pilot: Discovery-First DD",
          priority: 0,
          createdAt: "2026-03-09T00:00:00.000Z",
        }),
      ],
      {
        teamKey: "END",
        readyStateTypes: ["unstarted"],
        readyStateNames: ["Todo", "Backlog"],
        excludedProjectNames: ["Operator Harness"],
      },
      new Set(),
    );

    expect(selected?.identifier).toBe("END-7");
  });
});

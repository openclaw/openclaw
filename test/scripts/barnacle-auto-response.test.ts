import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  candidateLabels,
  classifyPullRequestCandidateLabels,
  managedLabelSpecs,
  runBarnacleAutoResponse,
} from "../../scripts/github/barnacle-auto-response.mjs";
import {
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
} from "../../scripts/github/real-behavior-proof-policy.mjs";

const clawSweeperProofSuppliedLabel = "proof: supplied";
const blankTemplateBody = readFileSync(
  new URL("../../.github/pull_request_template.md", import.meta.url),
  "utf8",
);

function pr(title: string, body = blankTemplateBody) {
  return { title, body };
}

function prContextBody(evidence: string) {
  return `## What Problem This Solves\n\nGateway status did not report the Discord channel as ready.\n\n## Evidence\n\n${evidence}`;
}

function file(filename: string, status = "modified", previousFilename?: string) {
  return {
    filename,
    status,
    ...(previousFilename ? { previous_filename: previousFilename } : {}),
  };
}

const repo = { owner: "openclaw", repo: "openclaw" };
const broadFiles = () => [
  file("ui/src/app.ts"),
  file("src/gateway/server.ts"),
  file("extensions/slack/src/index.ts"),
  file("docs/plugins/community.md"),
];
const labelEvent = (name: string, login = "maintainer", type = "User") => ({
  action: "labeled",
  label: { name },
  sender: { login, type },
});
const addedSkills = (...paths: string[]) => paths.map((path) => file(`skills/${path}`, "added"));

function barnacleContext(
  pullRequest: Record<string, unknown>,
  labels: string[] = [],
  options: Record<string, unknown> = {},
) {
  return {
    repo,
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      pull_request: {
        number: 123,
        title: "Cleanup plugin docs",
        body: blankTemplateBody,
        author_association: "CONTRIBUTOR",
        user: { login: "contributor" },
        labels: labels.map((name) => ({ name })),
        ...pullRequest,
      },
    },
  };
}

function barnacleIssueContext(
  issue: Record<string, unknown>,
  labels: string[] = [],
  options: Record<string, unknown> = {},
) {
  const { payload } = barnacleContext(issue, labels, options);
  const { pull_request, ...event } = payload;
  return {
    repo,
    payload: {
      ...event,
      issue: {
        ...pull_request,
        number: 456,
        title: "OpenClaw issue",
        body: "",
        ...issue,
      },
      comment: options.comment,
    },
  };
}

function barnacleGithub(
  files: ReturnType<typeof file>[],
  options: {
    maintainerLogins?: string[];
    removeLabelNotFound?: string[];
    repositoryRoles?: Record<string, string>;
  } = {},
  context?: ReturnType<typeof barnacleContext> | ReturnType<typeof barnacleIssueContext>,
) {
  const maintainerLogins = new Set(
    (options.maintainerLogins ?? []).map((login) => login.toLowerCase()),
  );
  const removeLabelNotFound = new Set(options.removeLabelNotFound ?? []);
  const repositoryRoles = Object.fromEntries(
    Object.entries(options.repositoryRoles ?? {}).map(([login, role]) => [
      login.toLowerCase(),
      role,
    ]),
  );
  const calls = {
    addLabels: [] as Array<{ issue_number: number; labels: string[] }>,
    createComment: [] as Array<{ issue_number: number; body: string }>,
    lock: [] as Array<{ issue_number: number; lock_reason?: string }>,
    removeLabel: [] as Array<{ issue_number: number; name: string }>,
    update: [] as Array<{ issue_number: number; state?: string }>,
  };
  const payload: Record<string, any> = context?.payload ?? {};
  const target = payload.issue ?? payload.pull_request ?? {};
  const state: Record<string, any> = {
    state: "open",
    locked: false,
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...structuredClone(target),
    node_id: "item",
    user: { id: 123, type: "User", ...target.user },
    ...(payload.pull_request
      ? { head: { sha: "a".repeat(40), ref: "feature", repo: { id: 55 } }, pull_request: {} }
      : {}),
  };
  const comments: Record<string, any>[] = [];
  const data = (value: unknown) => ({ data: structuredClone(value) });
  const github = {
    paginate: async () => files,
    rest: {
      issues: {
        get: async () => data(state),
        listComments: async () => data(comments),
        listEventsForTimeline: async () => data([]),
        getComment: async ({ comment_id }: { comment_id: number }) =>
          data(comments.find((comment) => comment.id === comment_id)),
        addLabels: async (params: { issue_number: number; labels: string[] }) => {
          calls.addLabels.push(params);
          state.labels.push(...params.labels.map((name) => ({ name })));
          return data(state.labels);
        },
        createComment: async (params: { issue_number: number; body: string }) => {
          calls.createComment.push(params);
          const comment = {
            ...params,
            id: comments.length + 1,
            node_id: `comment-${comments.length + 1}`,
            user: { id: 257215752, type: "Bot" },
            performed_via_github_app: { id: 2729701 },
            created_at: "2026-10-19T00:00:00Z",
            updated_at: "2026-10-19T00:00:00Z",
          };
          comments.push(comment);
          return data(comment);
        },
        createLabel: async () => undefined,
        getLabel: async (params: { name: string }) => ({
          data: {
            color:
              managedLabelSpecs[params.name as keyof typeof managedLabelSpecs]?.color ?? "C5DEF5",
            description:
              managedLabelSpecs[params.name as keyof typeof managedLabelSpecs]?.description ?? "",
          },
        }),
        lock: async (params: { issue_number: number; lock_reason?: string }) => {
          calls.lock.push(params);
          state.locked = true;
          return data(state);
        },
        removeLabel: async (params: { issue_number: number; name: string }) => {
          calls.removeLabel.push(params);
          state.labels = state.labels.filter(
            (label: { name: string }) => label.name !== params.name,
          );
          if (removeLabelNotFound.has(params.name)) {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
        },
        update: async (params: { issue_number: number; state?: string; state_reason?: string }) => {
          calls.update.push(params);
          Object.assign(state, params, { closed_by: { id: 257215752 } });
          return data(state);
        },
        updateLabel: async () => undefined,
      },
      pulls: {
        listFiles: async () => files,
        get: async () => data(state),
        listReviewComments: async () => data([]),
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => {
          const role = repositoryRoles[username.toLowerCase()] ?? "read";
          return { data: { permission: role, role_name: role } };
        },
      },
      teams: {
        getMembershipForUserInOrg: async ({ username }: { username: string }) => {
          if (maintainerLogins.has(username.toLowerCase())) {
            return { data: { state: "active" } };
          }
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      },
    },
  };
  Object.assign(github, {
    graphql: async (_query: string, variables: { ids?: string[]; head?: string }) => ({
      rateLimit: { remaining: 5000, cost: 1 },
      ...(variables.ids
        ? {
            nodes: variables.ids.map((id) => ({
              id,
              lastEditedAt: null,
              userContentEdits: {
                totalCount: 0,
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            })),
          }
        : {
            repository: {
              issue: { id: "item", lastEditedAt: null },
              pullRequest: {
                id: "item",
                lastEditedAt: null,
                reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          }),
    }),
  });
  return { calls, github };
}

function expectedIssueUpdate(issue_number: number, state: string) {
  return { ...repo, issue_number, state, state_reason: "not_planned" };
}

function expectedRemoveLabel(issue_number: number, name: string) {
  return { ...repo, issue_number, name };
}

function expectedAddLabels(issue_number: number, labels: string[]) {
  return { ...repo, issue_number, labels };
}

function labeledContext(label: string, login?: string, type?: string) {
  return barnacleContext({}, [label], labelEvent(label, login, type));
}

function expectClosed(calls: Awaited<ReturnType<typeof runBarnacle>>, issue: number, text: string) {
  expect(calls.createComment).toEqual([
    expect.objectContaining({ issue_number: issue, body: expect.stringContaining(text) }),
  ]);
  expect(calls.update).toStrictEqual([expectedIssueUpdate(issue, "closed")]);
}

function expectNoActions(
  calls: Awaited<ReturnType<typeof runBarnacle>>,
  keys: Array<keyof typeof calls>,
) {
  for (const key of keys) {
    expect(calls[key]).toStrictEqual([]);
  }
}

async function runBarnacle(
  context: ReturnType<typeof barnacleContext> | ReturnType<typeof barnacleIssueContext>,
  files: Parameters<typeof barnacleGithub>[0],
  options?: Parameters<typeof barnacleGithub>[1],
) {
  const { calls, github } = barnacleGithub(files, options, context);
  await runBarnacleAutoResponse({
    github,
    context,
    expectedAppId: 2729701,
    core: { info: () => undefined },
  });
  return calls;
}

describe("barnacle-auto-response", () => {
  it("does not treat template boilerplate as behavior evidence for test-only churn", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Add test coverage"), [
      file("src/gateway/foo.test.ts"),
    ]);
    expect(labels).toEqual([
      candidateLabels.blankTemplate,
      candidateLabels.needsPrContext,
      candidateLabels.testOnlyNoBug,
    ]);
  });

  it("classifies only changes confined to newly added ordinary skill roots for the ClawHub close", () => {
    for (const files of [
      [file("src/skills/loading/plugin-skills.test.ts")],
      [file("src/skills/workspace.ts")],
      [file("skills/weather/SKILL.md")],
      [file("custodian-skills/weather/SKILL.md", "added")],
      [file("skills/weather/SKILL.md", "added"), file("src/skills/workspace.ts")],
      [
        file("skills/weather/SKILL.md", "added"),
        file("skills/weather/runtime.ts", "renamed", "src/skills/runtime.ts"),
      ],
    ]) {
      expect(
        classifyPullRequestCandidateLabels(pr("Fix linked skill behavior", "Fixes #127931"), files),
      ).not.toContain("r: skill");
    }
    for (const files of [
      addedSkills("weather-helper/SKILL.md", "weather-helper/references/usage.md"),
      addedSkills("Group/Weather-Helper/skill.md", "Group/Weather-Helper/scripts/check.mjs"),
      addedSkills(
        "weather-helper/SKILL.md",
        "weather-helper/README.md",
        "group/calendar-helper/SKILL.md",
        "group/calendar-helper/assets/icon.svg",
      ),
    ]) {
      expect(classifyPullRequestCandidateLabels(pr("Add weather helper skill"), files)).toContain(
        "r: skill",
      );
    }
  });

  it("removes a stale automated skill close label from a mixed skill and core PR", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {
          title: "Add a skill and fix Windows symlink typing",
          body: "Fixes #127931",
        },
        ["r: skill"],
        labelEvent("r: skill", "openclaw-barnacle[bot]", "Bot"),
      ),
      [
        file("skills/weather-helper/SKILL.md", "added"),
        file("src/skills/loading/plugin-skills.test.ts"),
      ],
    );
    expect(calls.removeLabel).toContainEqual(expectedRemoveLabel(123, "r: skill"));
    expectNoActions(calls, ["createComment", "update"]);
  });

  it("does not duplicate the close for its own skill label event", async () => {
    const calls = await runBarnacle(labeledContext("r: skill", "openclaw-barnacle[bot]", "Bot"), [
      file("skills/weather-helper/SKILL.md", "added"),
    ]);
    expectNoActions(calls, ["createComment", "update"]);
  });

  it("honors a maintainer-applied skill close label", async () => {
    const calls = await runBarnacle(labeledContext("r: skill"), [file("src/skills/workspace.ts")], {
      maintainerLogins: ["maintainer"],
    });
    expect(calls.removeLabel).not.toContainEqual(expectedRemoveLabel(123, "r: skill"));
    expect(calls.createComment).toHaveLength(1);
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });

  it("suppresses dirty-candidate when the PR has concrete behavior context", () => {
    const body = [
      "- Problem: gateway crashes when plugin metadata is missing",
      "- Why it matters: users lose the running session",
      "- What changed: add a guard around metadata loading",
    ].join("\n");
    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway crash", body), broadFiles());
    expect(labels).not.toContain(candidateLabels.dirtyCandidate);
  });

  it("leaves stale Barnacle labels alone on maintainer-authored PRs", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {
          author_association: "OWNER",
          user: { login: "maintainer" },
        },
        [candidateLabels.dirtyCandidate, "r: too-many-prs"],
      ),
      broadFiles(),
    );
    expectNoActions(calls, ["addLabels", "createComment", "removeLabel", "update"]);
  });

  const pings = "@openclaw/maintainer testflight";
  const teamMembers = ["alice", "bob", "carol"];
  it.each([
    ["three maintainers", "@alice @bob @carol", "User", "reader", teamMembers, ["spam-ping"]],
    ["combined reply", pings, "User", "reader", [], ["spam-ping", "Not available"]],
    ["bot comment", pings, "Bot", "automation", [], []],
    ["maintainer comment", "testflight", "User", "maintainer", ["maintainer"], []],
  ] satisfies Array<[string, string, string, string, string[], string[]]>)(
    "preserves Barnacle comment actions for %s",
    async (_name, body, type, author, maintainers, messages) => {
      const calls = await runBarnacle(
        barnacleIssueContext({}, [], {
          action: "created",
          comment: { body, user: { login: author, type } },
        }),
        [],
        { maintainerLogins: maintainers },
      );
      expect(calls.createComment).toHaveLength(messages.length ? 1 : 0);
      for (const message of messages) {
        expect(calls.createComment[0]?.body).toContain(message);
      }
      expectNoActions(calls, ["addLabels", "removeLabel", "update", "lock"]);
    },
  );

  it("does not close automation PRs for the active PR limit", async () => {
    for (const [ref, login] of [
      ["clawsweeper/openclaw-openclaw-73880", "app/openclaw-clawsweeper"],
      ["clownfish/ghcrawl-156993-autonomous-smoke", "app/openclaw-clownfish"],
    ]) {
      for (const head of [{ head: { ref } }, { headRefName: ref }]) {
        const calls = await runBarnacle(
          barnacleContext({ ...head, user: { login } }, ["r: too-many-prs"]),
          [],
        );
        expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
        expect(
          calls.createComment.every((call) => !call.body.includes("more than 20 active PRs")),
        ).toBe(true);
        expect(calls.update).toStrictEqual([]);
      }
    }
  });

  it("preserves an app-authored PR on unconfirmed label removal and resumes from live state", async () => {
    const context = barnacleContext(
      {
        user: {
          login: "renovate[bot]",
          type: "Bot",
        },
      },
      ["r: too-many-prs"],
    );
    const { calls, github } = barnacleGithub(
      [file("README.md")],
      { removeLabelNotFound: ["r: too-many-prs"] },
      context,
    );
    const run = () =>
      runBarnacleAutoResponse({ github, context, expectedAppId: 2729701, core: { info() {} } });
    // A 404 does not confirm our write: fresh admission stops on the changed
    // live label set. A new invocation can safely observe that missing label.
    await expect(run()).rejects.toThrow("Barnacle target changed during response admission");
    expectNoActions(calls, ["createComment", "update"]);
    await run();
    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
    expectNoActions(calls, ["createComment", "update"]);
  });

  it("adds candidate labels with a GitHub Actions context repo getter", async () => {
    class ActionsContext {
      payload = barnacleContext({}).payload;

      get repo() {
        return repo;
      }
    }

    const calls = await runBarnacle(new ActionsContext(), broadFiles());
    expect(calls.addLabels).toStrictEqual([
      expectedAddLabels(123, [
        candidateLabels.blankTemplate,
        candidateLabels.needsPrContext,
        candidateLabels.refactorOnly,
        candidateLabels.dirtyCandidate,
      ]),
    ]);
    expectNoActions(calls, ["createComment", "update"]);
  });

  it("removes stale context labels without changing ClawSweeper proof labels", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {
          body: prContextBody("pnpm test passed."),
        },
        [
          candidateLabels.needsPrContext,
          "triage: mock-only-proof",
          clawSweeperProofSuppliedLabel,
          PROOF_SUFFICIENT_LABEL,
          PROOF_OVERRIDE_LABEL,
        ],
      ),
      [file("src/gateway/server.ts")],
    );
    expect(calls.removeLabel).toStrictEqual([
      expectedRemoveLabel(123, candidateLabels.needsPrContext),
    ]);
    expectNoActions(calls, ["addLabels", "update"]);
  });

  it("keeps context labels when sufficient proof is already present", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {},
        [PROOF_SUFFICIENT_LABEL, candidateLabels.needsPrContext],
        labelEvent("status: ready for maintainer look", "openclaw-clawsweeper[bot]", "Bot"),
      ),
      [file("src/gateway/server.ts")],
    );
    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).not.toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("does not let Barnacle veto ClawSweeper's sufficient proof label add", async () => {
    const calls = await runBarnacle(
      labeledContext(PROOF_SUFFICIENT_LABEL, "openclaw-clawsweeper[bot]", "Bot"),
      [file("src/gateway/server.ts")],
    );
    expectNoActions(calls, ["removeLabel", "addLabels", "update"]);
  });

  it("actions manually applied candidate labels", async () => {
    const calls = await runBarnacle(labeledContext(candidateLabels.externalPluginCandidate), [
      file("extensions/example/openclaw.plugin.json"),
    ]);
    expectClosed(calls, 123, "ClawHub");
  });

  it("closes manually labeled BlueBubbles requests with imsg migration guidance", async () => {
    const calls = await runBarnacle(
      barnacleIssueContext({}, ["r: bluebubbles"], labelEvent("r: bluebubbles")),
      [],
    );
    expectClosed(calls, 456, "/channels/imessage");
  });

  it("keeps bot-applied candidate labels passive", async () => {
    const calls = await runBarnacle(
      labeledContext(candidateLabels.externalPluginCandidate, "openclaw-bot[bot]", "Bot"),
      [file("extensions/example/openclaw.plugin.json")],
    );
    expectNoActions(calls, ["createComment", "update"]);
  });

  it("actions existing candidate labels when a maintainer adds trigger-response", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {},
        [candidateLabels.testOnlyNoBug, "trigger-response"],
        labelEvent("trigger-response"),
      ),
      [file("src/gateway/foo.test.ts")],
    );
    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "trigger-response")]);
    expectClosed(calls, 123, "lacks a clear problem statement or evidence");
  });
});

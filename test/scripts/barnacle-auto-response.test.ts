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
  return {
    repo,
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      issue: {
        number: 456,
        title: "OpenClaw issue",
        body: "",
        author_association: "CONTRIBUTOR",
        user: { login: "contributor" },
        labels: labels.map((name) => ({ name })),
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
  const listFiles = async () => files;
  const github = {
    paginate: async () => files,
    rest: {
      issues: {
        addLabels: async (params: { issue_number: number; labels: string[] }) => {
          calls.addLabels.push(params);
        },
        createComment: async (params: { issue_number: number; body: string }) => {
          calls.createComment.push(params);
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
        },
        removeLabel: async (params: { issue_number: number; name: string }) => {
          calls.removeLabel.push(params);
          if (removeLabelNotFound.has(params.name)) {
            const error = new Error("not found") as Error & { status: number };
            error.status = 404;
            throw error;
          }
        },
        update: async (params: { issue_number: number; state?: string }) => {
          calls.update.push(params);
        },
        updateLabel: async () => undefined,
      },
      pulls: {
        listFiles,
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => {
          const role = repositoryRoles[username.toLowerCase()] ?? "read";
          return {
            data: {
              permission: role,
              role_name: role,
            },
          };
        },
      },
      teams: {
        getMembershipForUserInOrg: async ({ username }: { username: string }) => {
          if (maintainerLogins.has(username.toLowerCase())) {
            return {
              data: {
                state: "active",
              },
            };
          }
          const error = new Error("not found") as Error & { status: number };
          error.status = 404;
          throw error;
        },
      },
    },
  };
  return { calls, github };
}

function expectedIssueUpdate(issue_number: number, state: string) {
  return { ...repo, issue_number, state };
}

function expectedRemoveLabel(issue_number: number, name: string) {
  return { ...repo, issue_number, name };
}

function expectedAddLabels(issue_number: number, labels: string[]) {
  return { ...repo, issue_number, labels };
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
  const { calls, github } = barnacleGithub(files, options);
  await runBarnacleAutoResponse({ github, context, core: { info: () => undefined } });
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
      [
        file("skills/weather-helper/SKILL.md", "added"),
        file("skills/weather-helper/references/usage.md", "added"),
      ],
      [
        file("skills/Group/Weather-Helper/skill.md", "added"),
        file("skills/Group/Weather-Helper/scripts/check.mjs", "added"),
      ],
      [
        file("skills/weather-helper/SKILL.md", "added"),
        file("skills/weather-helper/README.md", "added"),
        file("skills/group/calendar-helper/SKILL.md", "added"),
        file("skills/group/calendar-helper/assets/icon.svg", "added"),
      ],
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
    const calls = await runBarnacle(
      barnacleContext({}, ["r: skill"], labelEvent("r: skill", "openclaw-barnacle[bot]", "Bot")),
      [file("skills/weather-helper/SKILL.md", "added")],
    );

    expectNoActions(calls, ["createComment", "update"]);
  });

  it("honors a maintainer-applied skill close label", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, ["r: skill"], labelEvent("r: skill")),
      [file("src/skills/workspace.ts")],
      {
        maintainerLogins: ["maintainer"],
      },
    );

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

  it.each([
    {
      name: "three maintainers",
      body: "@alice @bob @carol",
      type: "User",
      author: "reader",
      maintainers: ["alice", "bob", "carol"],
      messages: ["spam-ping"],
    },
    {
      name: "combined reply",
      body: "@openclaw/maintainer testflight",
      type: "User",
      author: "reader",
      maintainers: [],
      messages: ["spam-ping", "Not available"],
    },
    {
      name: "bot comment",
      body: "@openclaw/maintainer testflight",
      type: "Bot",
      author: "automation",
      maintainers: [],
      messages: [],
    },
    {
      name: "maintainer comment",
      body: "testflight",
      type: "User",
      author: "maintainer",
      maintainers: ["maintainer"],
      messages: [],
    },
  ])("preserves Barnacle comment actions for $name", async (scenario) => {
    const { calls, github } = barnacleGithub([], { maintainerLogins: scenario.maintainers });
    await runBarnacleAutoResponse({
      github,
      context: barnacleIssueContext({}, [], {
        action: "created",
        comment: { body: scenario.body, user: { login: scenario.author, type: scenario.type } },
      }),
      core: { info: () => undefined },
    });
    expect(calls.createComment).toHaveLength(scenario.messages.length ? 1 : 0);
    for (const message of scenario.messages) {
      expect(calls.createComment[0]?.body).toContain(message);
    }
    expectNoActions(calls, ["addLabels", "removeLabel", "update", "lock"]);
  });

  it("does not close automation PRs for the active PR limit", async () => {
    for (const automationPullRequest of [
      { head: { ref: "clawsweeper/openclaw-openclaw-73880" }, login: "app/openclaw-clawsweeper" },
      { headRefName: "clawsweeper/openclaw-openclaw-73880", login: "app/openclaw-clawsweeper" },
      {
        head: { ref: "clownfish/ghcrawl-156993-autonomous-smoke" },
        login: "app/openclaw-clownfish",
      },
      { headRefName: "clownfish/ghcrawl-156993-autonomous-smoke", login: "app/openclaw-clownfish" },
    ]) {
      const { login, ...pullRequest } = automationPullRequest;

      const calls = await runBarnacle(
        barnacleContext(
          {
            ...pullRequest,
            user: { login },
          },
          ["r: too-many-prs"],
        ),
        [],
      );

      expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
      expect(
        calls.createComment.every((call) => !call.body.includes("more than 20 active PRs")),
      ).toBe(true);
      expect(calls.update).toStrictEqual([]);
    }
  });

  it("does not close GitHub App-authored PRs when stale PR-limit label removal returns 404", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
        },
        ["r: too-many-prs"],
      ),
      [file("README.md")],
      {
        removeLabelNotFound: ["r: too-many-prs"],
      },
    );

    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
    expectNoActions(calls, ["createComment", "update"]);
  });

  it("still adds candidate labels to broad contributor PRs", async () => {
    const calls = await runBarnacle(barnacleContext({}), broadFiles());

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
      barnacleContext(
        {},
        [PROOF_SUFFICIENT_LABEL],
        labelEvent(PROOF_SUFFICIENT_LABEL, "openclaw-clawsweeper[bot]", "Bot"),
      ),
      [file("src/gateway/server.ts")],
    );

    expectNoActions(calls, ["removeLabel", "addLabels", "update"]);
  });

  it("actions manually applied candidate labels", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {},
        [candidateLabels.externalPluginCandidate],
        labelEvent(candidateLabels.externalPluginCandidate),
      ),
      [file("extensions/example/openclaw.plugin.json")],
    );

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(123);
    expect(calls.createComment[0]?.body).toContain("ClawHub");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });

  it("closes manually labeled BlueBubbles requests with imsg migration guidance", async () => {
    const calls = await runBarnacle(
      barnacleIssueContext({}, ["r: bluebubbles"], labelEvent("r: bluebubbles")),
      [],
    );

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(456);
    expect(calls.createComment[0]?.body).toContain("/channels/imessage");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(456, "closed")]);
  });

  it("keeps bot-applied candidate labels passive", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {},
        [candidateLabels.externalPluginCandidate],
        labelEvent(candidateLabels.externalPluginCandidate, "openclaw-bot[bot]", "Bot"),
      ),
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
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(123);
    expect(calls.createComment[0]?.body).toContain("lacks a clear problem statement or evidence");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });
});

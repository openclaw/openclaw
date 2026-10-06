// Barnacle Auto Response tests cover barnacle auto response script behavior.
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
  return {
    title,
    body,
  };
}

function prContextBody(evidence: string, overrides: Record<string, string> = {}) {
  const fields = {
    problem: "Gateway status did not report the Discord channel as ready.",
    evidence,
    ...overrides,
  };
  return [
    "## What Problem This Solves",
    "",
    fields.problem,
    "",
    "## Evidence",
    "",
    fields.evidence,
  ].join("\n");
}

function file(filename: string, status = "modified", previousFilename?: string) {
  return {
    filename,
    status,
    ...(previousFilename ? { previous_filename: previousFilename } : {}),
  };
}

function barnacleContext(
  pullRequest: Record<string, unknown>,
  labels: string[] = [],
  options: Record<string, unknown> = {},
) {
  return {
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      pull_request: {
        number: 123,
        title: "Cleanup plugin docs",
        body: blankTemplateBody,
        author_association: "CONTRIBUTOR",
        user: {
          login: "contributor",
        },
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
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      issue: {
        number: 456,
        title: "OpenClaw issue",
        body: "",
        author_association: "CONTRIBUTOR",
        user: {
          login: "contributor",
        },
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
  return {
    owner: "openclaw",
    repo: "openclaw",
    issue_number,
    state,
  };
}

function expectedRemoveLabel(issue_number: number, name: string) {
  return {
    owner: "openclaw",
    repo: "openclaw",
    issue_number,
    name,
  };
}

function expectedAddLabels(issue_number: number, labels: string[]) {
  return {
    owner: "openclaw",
    repo: "openclaw",
    issue_number,
    labels,
  };
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
  it("labels docs-only discoverability churn without closing it", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Update README translation"), [
      file("README.md"),
    ]);

    expect(labels).toEqual([
      candidateLabels.blankTemplate,
      candidateLabels.needsPrContext,
      candidateLabels.lowSignalDocs,
      candidateLabels.docsDiscoverability,
    ]);
  });

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
        {
          action: "labeled",
          label: { name: "r: skill" },
          sender: { login: "openclaw-barnacle[bot]", type: "Bot" },
        },
      ),
      [
        file("skills/weather-helper/SKILL.md", "added"),
        file("src/skills/loading/plugin-skills.test.ts"),
      ],
    );

    expect(calls.removeLabel).toContainEqual(expectedRemoveLabel(123, "r: skill"));
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("closes a newly added ordinary skill and its assets deterministically", async () => {
    const calls = await runBarnacle(barnacleContext({ title: "Add weather helper skill" }), [
      file("skills/weather-helper/SKILL.md", "added"),
      file("skills/weather-helper/references/usage.md", "added"),
    ]);

    expect(calls.addLabels.flatMap((call) => call.labels)).toContain("r: skill");
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.body).toContain("ClawHub");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });

  it("does not duplicate the close for its own skill label event", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, ["r: skill"], {
        action: "labeled",
        label: { name: "r: skill" },
        sender: { login: "openclaw-barnacle[bot]", type: "Bot" },
      }),
      [file("skills/weather-helper/SKILL.md", "added")],
    );

    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("honors a maintainer-applied skill close label", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, ["r: skill"], {
        action: "labeled",
        label: { name: "r: skill" },
        sender: { login: "maintainer", type: "User" },
      }),
      [file("src/skills/workspace.ts")],
      {
        maintainerLogins: ["maintainer"],
      },
    );

    expect(calls.removeLabel).not.toContainEqual(expectedRemoveLabel(123, "r: skill"));
    expect(calls.createComment).toHaveLength(1);
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });

  it("uses the latest case-insensitive context sections after template boilerplate", () => {
    const body = [
      blankTemplateBody,
      "## What problem this solves",
      "",
      "Gateway status did not report the Discord channel as ready.",
      "",
      "## evidence",
      "",
      "pnpm test passed.",
    ].join("\n\n");
    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway status", body), [
      file("src/gateway/server.ts"),
    ]);

    expect(labels).not.toContain(clawSweeperProofSuppliedLabel);
    expect(labels).not.toContain(candidateLabels.blankTemplate);
    expect(labels).not.toContain(candidateLabels.needsPrContext);
  });

  it("accepts CRLF-formatted screenshot evidence without assigning a proof label", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix gateway startup",
        prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
          /\n/g,
          "\r\n",
        ),
      ),
      [file("src/gateway/server.ts")],
    );

    expect(labels).not.toContain(clawSweeperProofSuppliedLabel);
    expect(labels).not.toContain(candidateLabels.needsPrContext);
  });

  it("uses linked issues as context and suppresses low-signal docs labels", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr("Update docs", `${blankTemplateBody}\n\nRelated #12345`),
      [file("docs/plugins/community.md")],
    );

    expect(labels).not.toContain(candidateLabels.lowSignalDocs);
    expect(labels).not.toContain(candidateLabels.docsDiscoverability);
  });

  it("suppresses dirty-candidate when the PR has concrete behavior context", () => {
    const body = [
      "- Problem: gateway crashes when plugin metadata is missing",
      "- Why it matters: users lose the running session",
      "- What changed: add a guard around metadata loading",
    ].join("\n");

    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway crash", body), [
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    expect(labels).not.toContain(candidateLabels.dirtyCandidate);
  });

  it("does not classify a linked core plugin auto-enable fix as an external plugin candidate", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix duplicate plugin auto-enable entries",
        [
          "- Problem: openclaw doctor --fix adds duplicate installed plugin entries",
          "- Why it matters: users get noisy config churn",
          "- What changed: respect manifest-provided channel auto-loads",
          "",
          "Fixes #37548",
          "",
          "This touches external plugin install state but fixes core config repair behavior.",
        ].join("\n"),
      ),
      [
        file("src/config/plugin-auto-enable.shared.ts"),
        file("src/config/plugin-auto-enable.channels.test.ts"),
        file("src/config/plugin-auto-enable.test-helpers.ts"),
      ],
    );

    expect(labels).not.toContain(candidateLabels.externalPluginCandidate);
  });

  it("leaves stale Barnacle labels alone on maintainer-authored PRs", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {
          author_association: "OWNER",
          user: {
            login: "maintainer",
          },
        },
        [candidateLabels.dirtyCandidate, "r: too-many-prs"],
      ),
      [
        file("ui/src/app.ts"),
        file("src/gateway/server.ts"),
        file("extensions/slack/src/index.ts"),
        file("docs/plugins/community.md"),
      ],
    );

    expect(calls.addLabels).toStrictEqual([]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.removeLabel).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("does not mutate maintainer-authored issues", async () => {
    const calls = await runBarnacle(
      barnacleIssueContext({
        title: "TestFlight access",
        author_association: "OWNER",
        user: {
          login: "maintainer",
        },
      }),
      [],
    );

    expect(calls.addLabels).toStrictEqual([]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("does not action close labels on maintainer-authored issues", async () => {
    const calls = await runBarnacle(
      barnacleIssueContext(
        {
          title: "Need help with setup",
          author_association: "MEMBER",
          user: {
            login: "maintainer",
          },
        },
        ["r: support"],
        {
          action: "labeled",
          label: { name: "r: support" },
        },
      ),
      [],
    );

    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("closes issues tagged as false positives", async () => {
    const calls = await runBarnacle(
      barnacleIssueContext({}, ["r: false-positive"], {
        action: "labeled",
        label: { name: "r: false-positive" },
        sender: { login: "maintainer", type: "User" },
      }),
      [],
    );

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(456);
    expect(calls.createComment[0]?.body).toContain("false positive");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(456, "closed")]);
  });

  it.each([
    {
      name: "ordinary comment",
      body: "Thanks",
      type: "User",
      author: "reader",
      maintainers: [],
      messages: [],
    },
    {
      name: "keyword reply",
      body: "TESTFLIGHT",
      type: "User",
      author: "reader",
      maintainers: [],
      messages: ["Not available"],
    },
    {
      name: "team mention",
      body: "@openclaw/maintainer",
      type: "User",
      author: "reader",
      maintainers: [],
      messages: ["spam-ping"],
    },
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
    expect(calls.addLabels).toEqual([]);
    expect(calls.removeLabel).toEqual([]);
    expect(calls.update).toEqual([]);
    expect(calls.lock).toEqual([]);
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
            user: {
              login,
            },
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

  it("removes stale PR-limit labels from GitHub App-authored PRs", async () => {
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
    );

    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
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
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("still adds candidate labels to broad contributor PRs", async () => {
    const calls = await runBarnacle(barnacleContext({}), [
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    expect(calls.addLabels).toStrictEqual([
      expectedAddLabels(123, [
        candidateLabels.blankTemplate,
        candidateLabels.needsPrContext,
        candidateLabels.refactorOnly,
        candidateLabels.dirtyCandidate,
      ]),
    ]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
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
    expect(calls.addLabels).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("preserves manually applied sufficient proof label when override is added", async () => {
    const calls = await runBarnacle(
      barnacleContext(
        {
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
        },
        [PROOF_OVERRIDE_LABEL, PROOF_SUFFICIENT_LABEL],
        {
          action: "labeled",
          label: { name: PROOF_OVERRIDE_LABEL },
          sender: { login: "maintainer", type: "User" },
        },
      ),
      [file("src/gateway/server.ts")],
    );

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it.each(["edited", "synchronize"])(
    "preserves ClawSweeper sufficient proof labels after PR %s events",
    async (action) => {
      const calls = await runBarnacle(
        barnacleContext(
          {
            body: prContextBody(
              "![after](https://github.com/user-attachments/assets/gateway-ready)",
            ),
          },
          [clawSweeperProofSuppliedLabel, PROOF_SUFFICIENT_LABEL],
          { action },
        ),
        [file("src/gateway/server.ts")],
      );

      expect(calls.removeLabel).toEqual([]);
    },
  );

  it("adds missing context labels even when proof is sufficient", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [PROOF_SUFFICIENT_LABEL], {
        action: "labeled",
        label: { name: "status: ready for maintainer look" },
        sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
      }),
      [file("src/gateway/server.ts")],
    );

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("re-adds missing context labels while sufficient proof is present", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [PROOF_SUFFICIENT_LABEL], {
        action: "unlabeled",
        label: { name: candidateLabels.needsPrContext },
        sender: { login: "maintainer", type: "User" },
      }),
      [file("src/gateway/server.ts")],
    );

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("keeps context labels when sufficient proof is already present", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [PROOF_SUFFICIENT_LABEL, candidateLabels.needsPrContext], {
        action: "labeled",
        label: { name: "status: ready for maintainer look" },
        sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
      }),
      [file("src/gateway/server.ts")],
    );

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).not.toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("does not let Barnacle veto ClawSweeper's sufficient proof label add", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [PROOF_SUFFICIENT_LABEL], {
        action: "labeled",
        label: { name: PROOF_SUFFICIENT_LABEL },
        sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
      }),
      [file("src/gateway/server.ts")],
    );

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it("actions manually applied candidate labels", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [candidateLabels.externalPluginCandidate], {
        action: "labeled",
        label: { name: candidateLabels.externalPluginCandidate },
        sender: { login: "maintainer", type: "User" },
      }),
      [file("extensions/example/openclaw.plugin.json")],
    );

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(123);
    expect(calls.createComment[0]?.body).toContain("ClawHub");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });

  it("closes manually labeled BlueBubbles requests with imsg migration guidance", async () => {
    const calls = await runBarnacle(
      barnacleIssueContext({}, ["r: bluebubbles"], {
        action: "labeled",
        label: { name: "r: bluebubbles" },
        sender: { login: "maintainer", type: "User" },
      }),
      [],
    );

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(456);
    expect(calls.createComment[0]?.body).toContain("/channels/imessage");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(456, "closed")]);
  });

  it("keeps bot-applied candidate labels passive", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [candidateLabels.externalPluginCandidate], {
        action: "labeled",
        label: { name: candidateLabels.externalPluginCandidate },
        sender: { login: "openclaw-bot[bot]", type: "Bot" },
      }),
      [file("extensions/example/openclaw.plugin.json")],
    );

    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("actions existing candidate labels when a maintainer adds trigger-response", async () => {
    const calls = await runBarnacle(
      barnacleContext({}, [candidateLabels.testOnlyNoBug, "trigger-response"], {
        action: "labeled",
        label: { name: "trigger-response" },
        sender: { login: "maintainer", type: "User" },
      }),
      [file("src/gateway/foo.test.ts")],
    );

    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "trigger-response")]);
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(123);
    expect(calls.createComment[0]?.body).toContain("lacks a clear problem statement or evidence");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });
});

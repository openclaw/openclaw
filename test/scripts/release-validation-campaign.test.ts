import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  runReleaseValidationCampaignPublish,
  validateReleaseValidationCampaignArtifact,
} from "../../scripts/github/release-validation-campaign.mjs";

const TAG = "v2026.8.1-beta.3";
const TRAIN = "v2026.8.1";
const RELEASE_COMMIT = "a".repeat(40);
const GUIDANCE_SHA = "b".repeat(40);
const TITLE = "OpenClaw 2026.8.1 beta feedback";

const surface = "Runtime behavior changed. Run `{{OPENCLAW}} status`.\n| **Testing notes** | |\n";

function campaignBody(tag = TAG) {
  return [
    `<!-- openclaw-release-validation:${TRAIN} -->\n`,
    `- Current beta: [${tag}](https://github.com/openclaw/openclaw/releases/tag/${tag})`,
    `- Beta commit: \`${RELEASE_COMMIT}\``,
    `- Guidance main commit: \`${GUIDANCE_SHA}\``,
    "- Test target: latest immutable `origin/main`\n",
    "<!-- validation-guidance:start -->\n\n## Priority surfaces for this release\n",
    surface.repeat(3),
    `\n## Priority surfaces since ${tag}\n`,
    surface.repeat(3),
    "<!-- validation-guidance:end -->\n\n## Participate",
  ].join("\n");
}

function betaArtifact(tag = TAG) {
  return {
    schema: "openclaw.release-validation-campaign/v1",
    operation: "upsert",
    tag,
    stableTrain: TRAIN,
    releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/${tag}`,
    releaseCommit: RELEASE_COMMIT,
    guidanceMainSha: GUIDANCE_SHA,
    title: TITLE,
    body: campaignBody(tag),
  };
}

function issue(number: number, body: string, labels = ["release-validation"]) {
  return {
    number,
    state: "open",
    title: "old title",
    body,
    html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function harness(initialIssues: ReturnType<typeof issue>[]) {
  const issues = new Map(initialIssues.map((candidate) => [candidate.number, candidate]));
  const createComment = vi.fn(async (_args: Record<string, unknown>) => ({ data: {} }));
  const create = vi.fn(async (args: Record<string, unknown>) => {
    const created = Object.assign(issue(100, String(args.body)), args);
    issues.set(created.number, created);
    return { data: created };
  });
  const update = vi.fn(async (args: Record<string, unknown>) => {
    const data = Object.assign(issues.get(Number(args.issue_number))!, args);
    if (Array.isArray(args.labels)) {
      data.labels = args.labels.map((name) => ({ name: String(name) }));
    }
    return { data };
  });
  const github = {
    paginate: async () => [...issues.values()].filter((candidate) => candidate.state === "open"),
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        getLabel: async () => ({ data: {} }),
        createLabel: async () => ({ data: {} }),
        createComment,
        create,
        update,
        get: async ({ issue_number }: { issue_number: number }) => ({
          data: issues.get(issue_number),
        }),
      },
    },
  };
  const publish = (
    options: Partial<Parameters<typeof runReleaseValidationCampaignPublish>[0]> = {},
  ) =>
    runReleaseValidationCampaignPublish({
      github,
      core: { info: () => {}, setOutput: () => {} },
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      artifact: betaArtifact(),
      ...options,
    });
  return { createComment, create, update, publish };
}

it.each([
  ["| **Testing notes** | |", "| **Testing notes** | failed |", "testing-notes row"],
  ["Runtime behavior changed.", "/Users/test/private.log", "local filesystem path"],
])("rejects campaign body %s -> %s", (before, after, message) => {
  const artifact = betaArtifact();
  artifact.body = artifact.body.replace(before, after);
  expect(() => validateReleaseValidationCampaignArtifact(artifact)).toThrow(message);
});

it("creates the canonical campaign when none exists", async () => {
  const { publish } = harness([]);
  expect(await publish()).toMatchObject({ action: "create" });
});

it("updates the matching train and closes an older campaign", async () => {
  const older = issue(
    9,
    campaignBody().replaceAll(TRAIN, "v2026.7.1").replaceAll("2026.8.1", "2026.7.1"),
  );
  const { createComment, update, publish } = harness([issue(10, campaignBody()), older]);

  const result = await publish({
    expectedTag: TAG,
    expectedReleaseCommit: RELEASE_COMMIT,
    expectedGuidanceMainSha: GUIDANCE_SHA,
  });

  expect(result).toEqual({
    action: "update",
    issueNumber: 10,
    issueUrl: "https://github.com/openclaw/openclaw/issues/10",
  });
  expect(createComment).toHaveBeenCalledWith(
    expect.objectContaining({ issue_number: 9, body: expect.stringContaining("issues/10") }),
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ issue_number: 9, state: "closed", state_reason: "completed" }),
  );
});

it("migrates one explicitly selected legacy campaign", async () => {
  const legacy = issue(
    10,
    campaignBody().replace(
      `<!-- openclaw-release-validation:${TRAIN} -->`,
      `<!-- openclaw-release-validation:${TAG} -->`,
    ),
    ["maintainer"],
  );
  const { create, publish } = harness([legacy]);

  expect(await publish({ campaignIssueNumber: 10 })).toMatchObject({ action: "update" });
  expect(create).not.toHaveBeenCalled();
});

it("refuses to replace newer guidance with an older beta", async () => {
  const newerTag = "v2026.8.1-beta.4";
  const { publish } = harness([issue(10, campaignBody(newerTag))]);

  await expect(publish()).rejects.toThrow("older v2026.8.1-beta.3");
});

it("closes the matching train after a stable release", async () => {
  const { createComment, update, publish } = harness([
    issue(10, campaignBody(), ["release-validation", "keep"]),
  ]);

  const closing = publish({
    artifact: {
      schema: "openclaw.release-validation-campaign/v1",
      operation: "close",
      tag: TRAIN,
      stableTrain: TRAIN,
      releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/${TRAIN}`,
    },
  });

  expect(await closing).toMatchObject({ action: "close" });
  expect(createComment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      issue_number: 10,
      body: expect.stringContaining(`/tag/${TRAIN}`),
    }),
  );
  expect(update).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 10, state: "closed", labels: ["keep"] }),
  );
});

it("keeps the analysis job read-only and separates publication authority", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-validation-skill-runner.yml", "utf8"),
  );
  for (const permissions of [
    workflow.permissions,
    workflow.jobs.analyze.permissions ?? {},
    workflow.jobs.publish.permissions ?? {},
  ]) {
    expect(permissions).not.toBe("write-all");
    expect(Object.values(permissions)).not.toContain("write");
  }
  expect(
    workflow.jobs.analyze.steps.some((step: { uses?: string }) =>
      step.uses?.startsWith("actions/create-github-app-token@"),
    ),
  ).toBe(false);
  expect(workflow.jobs.publish.needs).toBe("analyze");
});

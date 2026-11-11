import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
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
  const getIssue = (number: number) => {
    const current = issues.get(number);
    if (!current) {
      throw new Error("missing issue");
    }
    return current;
  };
  const calls = {
    comments: [] as Array<Record<string, unknown>>,
    creates: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };
  let nextNumber = 100;
  const github = {
    paginate: async () => [...issues.values()].filter((candidate) => candidate.state === "open"),
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        getLabel: async () => ({ data: {} }),
        createLabel: async () => ({ data: {} }),
        createComment: async (args: Record<string, unknown>) => {
          calls.comments.push(args);
          return { data: {} };
        },
        create: async (args: Record<string, unknown>) => {
          calls.creates.push(args);
          const created = issue(nextNumber++, String(args.body));
          created.title = String(args.title);
          issues.set(created.number, created);
          return { data: created };
        },
        update: async (args: Record<string, unknown>) => {
          calls.updates.push(args);
          const current = getIssue(Number(args.issue_number));
          Object.assign(current, args);
          if (Array.isArray(args.labels)) {
            current.labels = args.labels.map((name) => ({ name: String(name) }));
          }
          return { data: current };
        },
        get: async ({ issue_number }: { issue_number: number }) => ({
          data: getIssue(issue_number),
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
  return { calls, publish };
}

function expectCall(calls: unknown[], fields: Record<string, unknown>) {
  expect(calls).toContainEqual(expect.objectContaining(fields));
}

function expectSingleCall(calls: unknown[], fields: Record<string, unknown>) {
  expect(calls).toEqual([expect.objectContaining(fields)]);
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
  const { calls, publish } = harness([]);
  expect(await publish()).toMatchObject({ action: "create" });
  expectSingleCall(calls.creates, { title: TITLE, labels: ["release-validation"] });
});

it("updates the matching train and closes an older campaign", async () => {
  const older = issue(
    9,
    campaignBody().replaceAll(TRAIN, "v2026.7.1").replaceAll("2026.8.1", "2026.7.1"),
  );
  const { calls, publish } = harness([issue(10, campaignBody()), older]);

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
  expectCall(calls.updates, { issue_number: 10, labels: ["release-validation"] });
  expectCall(calls.comments, { issue_number: 9, body: expect.stringContaining("issues/10") });
  expectCall(calls.updates, { issue_number: 9, state: "closed", state_reason: "completed" });
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
  const { calls, publish } = harness([legacy]);

  expect(await publish({ campaignIssueNumber: 10 })).toMatchObject({ action: "update" });
  expect(calls.creates).toHaveLength(0);
  expectCall(calls.updates, { issue_number: 10, labels: ["release-validation"] });
});

it("refuses to replace newer guidance with an older beta", async () => {
  const newerTag = "v2026.8.1-beta.4";
  const { publish } = harness([issue(10, campaignBody(newerTag))]);

  await expect(publish()).rejects.toThrow("older v2026.8.1-beta.3");
});

it("closes the matching train after a stable release", async () => {
  const { calls, publish } = harness([issue(10, campaignBody(), ["release-validation", "keep"])]);

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
  expectSingleCall(calls.comments, {
    issue_number: 10,
    body: expect.stringContaining(`/tag/${TRAIN}`),
  });
  expectSingleCall(calls.updates, { issue_number: 10, state: "closed", labels: ["keep"] });
});

it("keeps Codex read-only and publishes only through the validated artifact", () => {
  const workflow = readFileSync(".github/workflows/release-validation-skill-runner.yml", "utf8");

  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow).not.toContain("issues: write");
  expect(workflow).toContain("RELEASE_VALIDATION_ARTIFACT_PATH");
  expect(workflow).toContain("validateReleaseValidationCampaignArtifact");
  expect(workflow.indexOf("openai/codex-action@")).toBeLessThan(
    workflow.indexOf("actions/create-github-app-token@"),
  );
});

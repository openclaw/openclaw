import { expect, it } from "vitest";
import { runCiGitStep } from "./ci-git-owner.test-support.js";

// These admission jobs run on Ubuntu. The shared ci-platform-checkout suite
// owns native Windows Job Object proof for the same pinned owner.
const posixIt = it.skipIf(process.platform === "win32");
const sha = "a".repeat(40);
const otherSha = "f".repeat(40);
const releaseTag = "v2026.8.1";

type ReleaseMode = "linux" | "macos" | "placeholder";
type RunOptions = Partial<Parameters<typeof runCiGitStep>[0]>;

const releases: Record<ReleaseMode, Pick<RunOptions, "workflow" | "env" | "revisions">> = {
  linux: {
    workflow: {
      file: ".github/workflows/linux-app-release.yml",
      job: "validate_release",
      step: "Ensure tag commit is reachable from its release branch",
    },
    env: { RELEASE_TAG: releaseTag, WORKFLOW_SHA: otherSha },
    revisions: { [`refs/tags/${releaseTag}^{commit}`]: sha },
  },
  macos: {
    workflow: {
      file: ".github/workflows/macos-release.yml",
      job: "validate_macos_release_request",
      step: "Validate release tag and package metadata",
    },
    env: { PUBLIC_RELEASE_BRANCH: "main", RELEASE_TAG: releaseTag },
  },
  placeholder: {
    workflow: {
      file: ".github/workflows/npm-placeholder-bootstrap.yml",
      job: "plan",
      step: "Validate trusted workflow and target",
    },
    env: { EVENT_SHA: sha, SOURCE_REF: sha, WORKFLOW_REF: "refs/heads/main", WORKFLOW_SHA: sha },
  },
};

function releaseRun(signal: AbortSignal, mode: ReleaseMode, options: RunOptions = {}) {
  const release = releases[mode];
  return runCiGitStep({
    signal,
    workflow: release.workflow,
    fetchResults: [],
    ...options,
    env: { ...release.env, ...options.env },
    revisions: { ...release.revisions, ...options.revisions },
  });
}

function gitCommands(report: Awaited<ReturnType<typeof releaseRun>>) {
  return report.commands.filter(({ tool }) => tool === "git").map(({ args }) => args);
}

const head = ["rev-parse", "HEAD"];

posixIt.for([releaseTag, `${releaseTag}-2`])(
  "Linux admits a stable tag from its matching release branch: %s",
  { timeout: 55_000 },
  async (tag, { signal }) => {
    const report = await releaseRun(signal, "linux", {
      env: { RELEASE_TAG: tag },
      revisions: { [`refs/tags/${tag}^{commit}`]: sha },
      commandResults: {
        [`merge-base --is-ancestor ${sha} origin/main`]: { code: 1 },
        [`merge-base --is-ancestor ${sha} refs/remotes/origin/release/2026.8.1`]: { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.githubOutput).toBe(`tag_sha=${sha}\n`);
    expect(gitCommands(report)).toContainEqual([
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/release/2026.8.1:refs/remotes/origin/release/2026.8.1",
    ]);
  },
);

posixIt.for<ReleaseMode>(["linux", "macos", "placeholder"])(
  "%s admission drains every Git tree before output or consumer",
  { timeout: 55_000 },
  async (mode, { signal }) => {
    const report = await releaseRun(signal, mode);
    const output = { linux: `tag_sha=${sha}\n`, macos: "", placeholder: `sha=${sha}\n` }[mode];
    expect(report, report.output).toMatchObject({ code: 0, githubOutput: output });
    if (mode === "macos") {
      expect(report.commands.filter(({ tool }) => tool === "pnpm").map(({ args }) => args)).toEqual(
        [["release:openclaw:npm:check"]],
      );
    }
    expect(report.boundaries).toContainEqual(
      expect.objectContaining({ name: mode === "macos" ? "consumer:pnpm" : "output" }),
    );
  },
);

type FailureCase = [ReleaseMode, RunOptions, Record<string, unknown>];
const fault = (operation: string, code = 23, occurrence?: number) => ({
  gitFault: { match: `^${operation} `, code, occurrence },
});
const ancestry = (revision: string, branch = "origin/main") =>
  `merge-base --is-ancestor ${revision} ${branch}`;
const shaRejection =
  "NPM placeholder publication requires ref to equal the exact main workflow SHA.";
const rejects = (message: string, expected = {}) => ({
  code: 1,
  output: expect.stringContaining(message),
  ...expected,
});
// Owner startup, cancellation and drain faults are covered by
// ci-platform-checkout.test.ts; here retain each workflow's admission decisions.
const failures: FailureCase[] = [
  ...(["linux", "macos", "placeholder"] as const).map((mode): FailureCase => [
    mode,
    { fetchResults: [23] },
    { code: 23, operation: "fetch" },
  ]),
  ...(["linux", "macos"] as const).map((mode): FailureCase => [
    mode,
    fault("rev-parse"),
    { code: 23, operation: "rev-parse" },
  ]),
  ["linux", fault("merge-base"), { code: 23, operation: "merge-base" }],
  ["placeholder", fault("rev-parse"), rejects(shaRejection, { gitCount: 1 })],
  [
    "linux",
    { commandResults: { [ancestry(sha)]: { code: 1 } }, ...fault("fetch", 128, 2) },
    { code: 128, operation: "fetch" },
  ],
  ...[1, 2].map((occurrence): FailureCase => [
    "placeholder",
    fault("merge-base", 23, occurrence),
    rejects(occurrence === 1 ? "workflow revision is not reachable" : "target must be reachable", {
      mergeBases: occurrence,
    }),
  ]),
  [
    "macos",
    { env: { PUBLIC_RELEASE_BRANCH: "feature/not-a-release" } },
    rejects(
      "public_release_branch must be main or release/YYYY.M.PATCH, got feature/not-a-release.",
      {
        gitCount: 0,
      },
    ),
  ],
  [
    "linux",
    {
      commandResults: {
        [ancestry(sha)]: { code: 1 },
        [ancestry(sha, "refs/remotes/origin/release/2026.8.1")]: { code: 1 },
      },
    },
    rejects(`Tag ${releaseTag} (${sha}) is not reachable from main or release/2026.8.1.`),
  ],
  [
    "linux",
    { commandResults: { [ancestry(otherSha)]: { code: 1 } } },
    rejects("Linux release tooling must be reachable from current main.", {
      candidateInspected: false,
    }),
  ],
  [
    "placeholder",
    { env: { WORKFLOW_REF: "refs/heads/release/2026.8.1" } },
    rejects("must run from the trusted main workflow", { gitCount: 0 }),
  ],
  ["placeholder", { env: { EVENT_SHA: otherSha } }, rejects(shaRejection, { gitCount: 0 })],
  [
    "placeholder",
    { commandResults: { "rev-parse HEAD": { code: 0, output: `${otherSha}\n` } } },
    rejects(shaRejection, { git: [head] }),
  ],
];

posixIt.for(failures)(
  "%s admission rejects %j",
  { timeout: 55_000 },
  async ([mode, options, expected], { signal }) => {
    const report = await releaseRun(signal, mode, options);
    const git = gitCommands(report);
    expect(report.code, report.output).not.toBe(0);
    expect(
      {
        ...report,
        git,
        gitCount: git.length,
        operation: git.at(-1)?.[0],
        pnpm: report.commands.some(({ tool }) => tool === "pnpm"),
        mergeBases: git.filter(([op]) => op === "merge-base").length,
        candidateInspected: git.some(([op]) => op === "rev-parse"),
      },
      report.output,
    ).toMatchObject({ githubOutput: "", pnpm: false, ...expected });
  },
);

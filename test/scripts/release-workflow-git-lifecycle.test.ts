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

const releases: Record<
  ReleaseMode,
  [file: string, job: string, step: string, options: RunOptions]
> = {
  linux: [
    "linux-app-release",
    "validate_release",
    "Ensure tag commit is reachable from its release branch",
    {
      env: { RELEASE_TAG: releaseTag, WORKFLOW_SHA: otherSha },
      revisions: { [`refs/tags/${releaseTag}^{commit}`]: sha },
    },
  ],
  macos: [
    "macos-release",
    "validate_macos_release_request",
    "Validate release tag and package metadata",
    { env: { PUBLIC_RELEASE_BRANCH: "main", RELEASE_TAG: releaseTag } },
  ],
  placeholder: [
    "npm-placeholder-bootstrap",
    "plan",
    "Validate trusted workflow and target",
    {
      env: { EVENT_SHA: sha, SOURCE_REF: sha, WORKFLOW_REF: "refs/heads/main", WORKFLOW_SHA: sha },
    },
  ],
};

function releaseRun(signal: AbortSignal, mode: ReleaseMode, options: RunOptions = {}) {
  const [file, job, step, defaults] = releases[mode];
  return runCiGitStep({
    signal,
    workflow: { file: `.github/workflows/${file}.yml`, job, step },
    fetchResults: [],
    ...options,
    env: { ...defaults.env, ...options.env },
    revisions: { ...defaults.revisions, ...options.revisions },
  });
}

type AdmissionCase = [ReleaseMode, RunOptions, Record<string, unknown>];
const fault = (operation: string, code = 23, occurrence?: number) => ({
  gitFault: { match: `^${operation} `, code, occurrence },
});
const ancestry = (revision: string, branch = "origin/main") =>
  `merge-base --is-ancestor ${revision} ${branch}`;
const rejects = (message: string, expected = {}) => ({
  code: 1,
  output: expect.stringContaining(message),
  ...expected,
});
// Owner startup, cancellation and drain faults are covered by
// ci-platform-checkout.test.ts; here retain each workflow's admission decisions.
const admissions: AdmissionCase[] = [
  ...(["linux", "macos", "placeholder"] as const).map((mode): AdmissionCase => [
    mode,
    {},
    {
      code: 0,
      githubOutput: { linux: `tag_sha=${sha}\n`, macos: "", placeholder: `sha=${sha}\n` }[mode],
      pnpm: mode === "macos",
      ...(mode === "macos" ? { pnpmArgs: [["release:openclaw:npm:check"]] } : {}),
      boundaries: expect.arrayContaining([
        expect.objectContaining({ name: mode === "macos" ? "consumer:pnpm" : "output" }),
      ]),
    },
  ]),
  ...[releaseTag, `${releaseTag}-2`].map((tag): AdmissionCase => [
    "linux",
    {
      env: { RELEASE_TAG: tag },
      revisions: { [`refs/tags/${tag}^{commit}`]: sha },
      commandResults: {
        [ancestry(sha)]: { code: 1 },
        [ancestry(sha, "refs/remotes/origin/release/2026.8.1")]: { code: 0 },
      },
    },
    {
      code: 0,
      githubOutput: `tag_sha=${sha}\n`,
      git: expect.arrayContaining([
        [
          "fetch",
          "--no-tags",
          "origin",
          "+refs/heads/release/2026.8.1:refs/remotes/origin/release/2026.8.1",
        ],
      ]),
    },
  ]),
  ...(["linux", "macos"] as const).map((mode): AdmissionCase => [
    mode,
    { fetchResults: [23] },
    { code: 23, operation: "fetch" },
  ]),
  ["macos", fault("rev-parse"), { code: 23, operation: "rev-parse" }],
  ["linux", fault("merge-base"), { code: 23, operation: "merge-base" }],
  ["placeholder", fault("rev-parse"), rejects("exact main workflow SHA", { gitCount: 1 })],
  ...[1, 2].map((occurrence): AdmissionCase => [
    "placeholder",
    fault("merge-base", 23, occurrence),
    rejects(occurrence === 1 ? "workflow revision is not reachable" : "target must be reachable", {
      mergeBases: occurrence,
    }),
  ]),
  [
    "macos",
    { env: { PUBLIC_RELEASE_BRANCH: "feature/not-a-release" } },
    rejects("public_release_branch must be main or release/", { gitCount: 0 }),
  ],
  [
    "linux",
    {
      commandResults: {
        [ancestry(sha)]: { code: 1 },
        [ancestry(sha, "refs/remotes/origin/release/2026.8.1")]: { code: 1 },
      },
    },
    rejects(`Tag ${releaseTag} (${sha}) is not reachable`),
  ],
  [
    "linux",
    { commandResults: { [ancestry(otherSha)]: { code: 1 } } },
    rejects("Linux release tooling must be reachable", { candidateInspected: false }),
  ],
  [
    "placeholder",
    { env: { WORKFLOW_REF: "refs/heads/release/2026.8.1" } },
    rejects("must run from the trusted main workflow", { gitCount: 0 }),
  ],
  [
    "placeholder",
    { env: { EVENT_SHA: otherSha } },
    rejects("exact main workflow SHA", { gitCount: 0 }),
  ],
  [
    "placeholder",
    { commandResults: { "rev-parse HEAD": { code: 0, output: `${otherSha}\n` } } },
    rejects("exact main workflow SHA", { git: [["rev-parse", "HEAD"]] }),
  ],
];

posixIt.for(admissions)(
  "%s admission and Git lifecycle: %j",
  { timeout: 55_000 },
  async ([mode, options, expected], { signal }) => {
    const report = await releaseRun(signal, mode, options);
    const git = report.commands.filter(({ tool }) => tool === "git").map(({ args }) => args);
    expect(
      {
        ...report,
        git,
        gitCount: git.length,
        operation: git.at(-1)?.[0],
        pnpm: report.commands.some(({ tool }) => tool === "pnpm"),
        pnpmArgs: report.commands.filter(({ tool }) => tool === "pnpm").map(({ args }) => args),
        mergeBases: git.filter(([op]) => op === "merge-base").length,
        candidateInspected: git.some(([op]) => op === "rev-parse"),
      },
      report.output,
    ).toMatchObject({ githubOutput: "", pnpm: false, ...expected });
  },
);

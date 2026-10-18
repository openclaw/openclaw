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
type GitFault = NonNullable<RunOptions["gitFault"]>;

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

const fetchMain = ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
const head = ["rev-parse", "HEAD"];
const onMain = (revision: string) => ["merge-base", "--is-ancestor", revision, "origin/main"];

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
      ...fetchMain.slice(0, 3),
      "+refs/heads/release/2026.8.1:refs/remotes/origin/release/2026.8.1",
    ]);
  },
);

posixIt.for([
  {
    mode: "linux" as const,
    commands: [
      fetchMain,
      onMain(otherSha),
      ["rev-parse", `refs/tags/${releaseTag}^{commit}`],
      onMain(sha),
    ],
    output: `tag_sha=${sha}\n`,
  },
  {
    mode: "macos" as const,
    commands: [head, fetchMain],
    output: "",
  },
  {
    mode: "placeholder" as const,
    commands: [head, fetchMain, onMain(sha), onMain(sha)],
    output: `sha=${sha}\n`,
  },
])(
  "$mode admission drains every Git tree before output or consumer",
  { timeout: 55_000 },
  async ({ mode, commands, output }, { signal }) => {
    const report = await releaseRun(signal, mode);
    expect(report, report.output).toMatchObject({ code: 0, githubOutput: output });
    expect(gitCommands(report)).toEqual(commands);
    expect(report.readyAttempts).toHaveLength(commands.length);
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

type FailureCase = { mode: ReleaseMode; options: RunOptions; expected: Record<string, unknown> };
const failures: FailureCase[] = [];
const addFailure = (
  mode: ReleaseMode,
  options: RunOptions,
  expected: Record<string, unknown> = {},
) => failures.push({ mode, options, expected });
const fault = (operation: string, code: GitFault["code"], occurrence?: number) => ({
  gitFault: { match: `^${operation} `, code, occurrence },
});
const ancestry = (revision: string, branch = "origin/main") =>
  `merge-base --is-ancestor ${revision} ${branch}`;
const shaRejection =
  "NPM placeholder publication requires ref to equal the exact main workflow SHA.";
const failureCodes = { cancel: 143, "cleanup-failure": 125, hang: 124 };
const failureCode = (failure: GitFault["code"]) =>
  typeof failure === "number" ? failure : failureCodes[failure];

for (const mode of ["linux", "macos", "placeholder"] as const) {
  for (const failure of [23, 125, "hang"] as const) {
    addFailure(
      mode,
      { fetchResults: [failure] },
      { code: failureCode(failure), operation: "fetch" },
    );
  }
  for (const setupFailure of ["owner", "python", "git"] as const) {
    addFailure(mode, { setupFailure });
  }
}
for (const mode of ["linux", "macos"] as const) {
  for (const code of [23, 125]) {
    addFailure(mode, fault("rev-parse", code), { code, operation: "rev-parse" });
  }
}
for (const [mode, operation, occurrence] of [
  ["linux", "fetch"],
  ["linux", "rev-parse"],
  ["linux", "merge-base"],
  ["macos", "rev-parse"],
  ["macos", "fetch"],
  ["placeholder", "rev-parse"],
  ["placeholder", "fetch"],
  ["placeholder", "merge-base", 1],
  ["placeholder", "merge-base", 2],
] as const) {
  for (const failure of ["cleanup-failure", "cancel"] as const) {
    addFailure(mode, fault(operation, failure, occurrence), {
      code: failureCode(failure),
      operation,
      terminalMessage: false,
    });
  }
}
for (const code of [23, 125]) {
  addFailure("linux", fault("merge-base", code), { code, operation: "merge-base" });
  addFailure("placeholder", fault("rev-parse", code), {
    code: 1,
    output: expect.stringContaining(shaRejection),
    gitCount: 1,
  });
}
for (const failure of [128, "cleanup-failure", "cancel"] as const) {
  addFailure(
    "linux",
    {
      commandResults: { [ancestry(sha)]: { code: 1 } },
      ...fault("fetch", failure, 2),
    },
    {
      code: failureCode(failure),
      operation: "fetch",
    },
  );
}
for (const occurrence of [1, 2]) {
  addFailure("placeholder", fault("merge-base", 23, occurrence), {
    code: 1,
    mergeBases: occurrence,
    output: expect.stringContaining(
      occurrence === 1 ? "workflow revision is not reachable" : "target must be reachable",
    ),
  });
}
addFailure(
  "macos",
  { env: { PUBLIC_RELEASE_BRANCH: "feature/not-a-release" } },
  {
    code: 1,
    gitCount: 0,
    output: expect.stringContaining(
      "public_release_branch must be main or release/YYYY.M.PATCH, got feature/not-a-release.",
    ),
  },
);
addFailure(
  "linux",
  {
    commandResults: {
      [ancestry(sha)]: { code: 1 },
      [ancestry(sha, "refs/remotes/origin/release/2026.8.1")]: { code: 1 },
    },
  },
  {
    code: 1,
    output: expect.stringContaining(
      `Tag ${releaseTag} (${sha}) is not reachable from main or release/2026.8.1.`,
    ),
  },
);
addFailure(
  "linux",
  { commandResults: { [ancestry(otherSha)]: { code: 1 } } },
  {
    code: 1,
    candidateInspected: false,
    output: expect.stringContaining("Linux release tooling must be reachable from current main."),
  },
);
addFailure(
  "placeholder",
  { env: { WORKFLOW_REF: "refs/heads/release/2026.8.1" } },
  {
    code: 1,
    gitCount: 0,
    output: expect.stringContaining("must run from the trusted main workflow"),
  },
);
addFailure(
  "placeholder",
  { env: { EVENT_SHA: otherSha } },
  {
    code: 1,
    gitCount: 0,
    output: expect.stringContaining("requires ref to equal the exact main workflow SHA"),
  },
);
addFailure(
  "placeholder",
  { commandResults: { "rev-parse HEAD": { code: 0, output: `${otherSha}\n` } } },
  { code: 1, git: [head], output: expect.stringContaining(shaRejection) },
);

posixIt.for(failures)(
  "$mode admission rejects $options",
  { timeout: 55_000 },
  async ({ mode, options, expected }, { signal }) => {
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
        terminalMessage: /not reachable|requires ref to equal/u.test(report.output),
        candidateInspected: git.some(([op]) => op === "rev-parse"),
      },
      report.output,
    ).toMatchObject({ githubOutput: "", pnpm: false, ...expected });
  },
);

import path from "node:path";
import { beforeAll, expect, it, vi, type TestContext, type TestFunction } from "vitest";
import { runCiGitStep, type FetchResult } from "./ci-git-owner.test-support.js";

beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

const candidate = "a".repeat(40);
const harness = "b".repeat(40);
const base = "c".repeat(40);
const moved = "d".repeat(40);
const merge = "e".repeat(40);
function timed(test: typeof it.concurrent) {
  return Object.assign((name: string, fn: TestFunction) => test(name, fn, 55_000), {
    for:
      <T>(cases: readonly T[]) =>
      (name: string, fn: (entry: T, context: TestContext) => Promise<void>) =>
        test.for(cases)(name, { timeout: 55_000 }, fn),
  });
}
const linuxIt = timed(it.skipIf(process.platform !== "linux").concurrent);
// Raw owner lifecycle checks use the shared POSIX census on Linux and macOS.
const posixIt = timed(it.skipIf(process.platform === "win32").concurrent);
const noOutputs = { githubOutput: "", githubEnv: "", githubSummary: "", githubPath: "" };
const docsClone = "Clone publish repo";
const docsCommit = "Commit publish repo sync";
const command = (words: string, ...args: string[]) => [...words.split(" "), ...args];
type GitOptions = Partial<Parameters<typeof runCiGitStep>[0]>;
const length = (value: number) => expect.objectContaining({ length: value });
const fetchCase = (label: string, code: number, ...fetchResults: FetchResult[]) => ({
  label,
  code,
  fetchResults,
  attempts: fetchResults.length,
});

function runCheckout(
  signal: AbortSignal,
  job: string,
  fetchResults: FetchResult[],
  options: GitOptions = {},
) {
  return runCiGitStep({ signal, job, fetchResults, ...options });
}

const resetProfiles = (
  [
    ["android", "Checkout", `+${candidate}:refs/remotes/origin/ci-target`, "fixture/checkout"],
    [
      "check-docs",
      "Checkout ClawHub docs source",
      "+refs/heads/main:refs/remotes/origin/checkout",
      "openclaw/clawhub",
    ],
  ] as const
).map(([job, step, target, remote]) => ({ job, step, target, remote }));
// Retry, extinction and reset ordering are owned by ci-platform-checkout.test.ts.
linuxIt.for(resetProfiles)(
  "$job checks out its repository and target",
  async ({ job, step, target, remote }, { signal }) => {
    const report = await runCiGitStep({ signal, job, step, fetchResults: [0] });
    expect(report).toMatchObject({ code: 0, fetches: length(1), checkouts: length(1) });
    expect(report.fetches[0]).toMatchObject({
      args: expect.arrayContaining([target, "--depth=1", "--no-tags", "--no-recurse-submodules"]),
      cwd: job === "android" ? report.workspace : path.join(report.workspace, "clawhub-source"),
    });
    expect(
      report.commands
        .filter(({ args }) => args[0] === "remote")
        .every(({ args }) => args.at(-1) === `https://github.com/${remote}.git`),
    ).toBe(true);
  },
);

linuxIt.for([
  fetchCase("timeout recovery", 0, "hang", 0),
  fetchCase("timeouts exhausted", 124, "hang", "hang", "hang"),
  fetchCase("ordinary Git failure", 23, 23),
])(
  "skills preserves exact-SHA retries without a fallback ($label)",
  async ({ fetchResults, code, attempts }, { signal }) => {
    const report = await runCiGitStep({ signal, job: "skills-python", fetchResults });
    expect(report).toMatchObject({
      code,
      fetches: length(attempts),
      checkouts: length(code === 0 ? 1 : 0),
    });
    expect(
      report.fetches.every(
        ({ args }) =>
          args.includes(`+${candidate}:refs/remotes/origin/checkout`) && args.includes("--depth=1"),
      ),
    ).toBe(true);
    expect(report.boundaries.some(({ name }) => name === "delete")).toBe(false);
  },
);

const manualProfiles = [
  { job: "preflight", step: "Checkout", depth: 1 },
  { job: "security-fast", step: "Checkout manual target", depth: 2 },
];
linuxIt.for(manualProfiles)(
  "$job falls back from an unavailable manual target",
  async ({ job, step, depth }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      job,
      step,
      fetchResults: [128, 0],
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: "refs/heads/missing" },
    });
    expect(report.code).toBe(0);
    const targetFetches = report.fetches.filter(({ args }) =>
      args.some((arg) => arg.endsWith(":refs/remotes/origin/checkout")),
    );
    expect(lastArgs(targetFetches)).toEqual([
      "+refs/heads/missing:refs/remotes/origin/checkout",
      `+${candidate}:refs/remotes/origin/checkout`,
    ]);
    expect(targetFetches.every(({ args }) => args.includes(`--depth=${depth}`))).toBe(true);
    expect(report.fetches).toHaveLength(targetFetches.length + (job === "preflight" ? 1 : 0));
    expect(report.checkouts).toHaveLength(1);
  },
);

linuxIt("manual timeouts never fall back to another ref", async ({ signal }) => {
  const report = await runCheckout(signal, "security-fast", ["hang", "hang", "hang"], {
    step: "Checkout manual target",
    env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: "refs/heads/missing" },
  });
  expect(report).toMatchObject({ code: 124, checkouts: [] });
  expect(lastArgs(report.fetches)).toEqual(
    Array.from({ length: 3 }, () => "+refs/heads/missing:refs/remotes/origin/checkout"),
  );
});

linuxIt("pins preflight SHA while retrying parent metadata", async ({ signal }) => {
  const report = await runCheckout(signal, "preflight", [0, 0, 23, 0], {
    env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
    poisonPython: true,
  });
  expect(report.code).toBe(0);
  expect(lastArgs(report.fetches)).toEqual([
    "+refs/heads/main:refs/remotes/origin/checkout",
    `+${candidate}:refs/remotes/origin/checkout`,
    candidate,
    candidate,
  ]);
  for (const fetch of report.fetches.slice(2)) {
    expect(fetch.args).toEqual(expect.arrayContaining(["--depth=2", "--filter=blob:none"]));
  }
  expect(argsOf(report.checkouts)).toEqual([
    command("checkout --detach refs/remotes/origin/checkout"),
  ]);
});

linuxIt("manual security never refetches an unavailable equal fallback", async ({ signal }) => {
  const report = await runCheckout(signal, "security-fast", [128], {
    step: "Checkout manual target",
    env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
  });
  expect(report.code).toBe(128);
  expect(lastArgs(report.fetches)).toEqual([`+${candidate}:refs/remotes/origin/checkout`]);
  expect(report.checkouts).toEqual([]);
});

linuxIt("rejects a fallback for a different exact SHA", async ({ signal }) => {
  const report = await runCheckout(signal, "preflight", [128, 0], {
    env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: moved },
  });
  expect(report.code).toBe(1);
  expect(lastArgs(report.fetches)).toEqual([
    `+${moved}:refs/remotes/origin/checkout`,
    `+${candidate}:refs/remotes/origin/checkout`,
  ]);
  expect(report.checkouts).toEqual([]);
});

const preflightCases: (ReturnType<typeof fetchCase> & { env: Record<string, string> })[] = [
  {
    ...fetchCase("push never substitutes another ref", 128, 128),
    env: { GITHUB_EVENT_NAME: "push", CHECKOUT_REF: "refs/heads/missing" },
  },
  {
    ...fetchCase("unavailable fallback does not recurse", 128, 128),
    env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
  },
  {
    ...fetchCase("parent metadata failure prevents checkout", 1, 0, 23, 23, 23),
    env: {},
  },
];
linuxIt.for(preflightCases)(
  "preflight fails closed: $label",
  async ({ env, fetchResults, code }, { signal }) => {
    const report = await runCiGitStep({ signal, job: "preflight", env, fetchResults });
    expect(report).toMatchObject({ code, fetches: length(fetchResults.length), checkouts: [] });
  },
);

const historyProfiles: {
  job: string;
  step: string;
  env: Record<string, string>;
  target: string;
}[] = [
  {
    job: "preflight",
    step: "Resolve exact diff base",
    env: {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      RELEASE_GATE: "true",
      DISPATCH_ID: "",
      TARGET_CONTEXT_REF: "",
      WORKFLOW_REVISION: harness,
    },
    target: "+refs/pull/17/merge:refs/remotes/origin/release-gate-merge",
  },
  {
    job: "checks-fast-core",
    step: "Prepare release-gate ratchet merge tree",
    env: {},
    target: "+refs/pull/17/merge:refs/remotes/origin/ci-ratchet-merge",
  },
];

linuxIt.for(historyProfiles)(
  "$job/$step publishes the supplemental history ($target)",
  async ({ job, step, env, target }, { signal }) => {
    const report = await runCheckout(signal, job, [0], {
      step,
      env,
      prepare: true,
      poisonPython: true,
    });
    expect(report).toMatchObject({ code: 0, fetches: length(1) });
    expect(report.fetches[0]?.args).toEqual(expect.arrayContaining([target, "--depth=2"]));
    if (step === "Resolve exact diff base") {
      expect(report.githubOutput).toBe(`sha=${base}\nhead_sha=${merge}\n`);
    }
    if (step === "Prepare release-gate ratchet merge tree") {
      expect(report.githubEnv).toBe(`RATCHET_BASE_REF=${base}\n`);
      expect(lastArgs(report.checkouts)).toEqual([merge]);
    }
  },
);

linuxIt("retries stale ratchet parents before publishing", async ({ signal }) => {
  const report = await runCheckout(signal, "checks-fast-core", [0, 0], {
    step: "Prepare release-gate ratchet merge tree",
    mergeSnapshots: [
      { sha: "f".repeat(40), head: moved },
      { sha: merge, head: candidate },
    ],
    prepare: true,
  });
  expect(report.code).toBe(0);
  expect(lastArgs(report.fetches)).toEqual([
    "+refs/pull/17/merge:refs/remotes/origin/ci-ratchet-merge",
    "+refs/pull/17/merge:refs/remotes/origin/ci-ratchet-merge",
  ]);
  expect(
    report.boundaries
      .filter(
        ({ name }) => name.startsWith("fetch:") || name === "show-parents" || name === "checkout",
      )
      .map(({ name }) => name),
  ).toEqual(["fetch:1", "show-parents", "fetch:2", "show-parents", "checkout"]);
  expect(lastArgs(report.checkouts)).toEqual([merge]);
  expect(report.githubEnv).toBe(`RATCHET_BASE_REF=${base}\n`);
});

posixIt("fetches only the harness bloblessly", async ({ signal }) => {
  const report = await runCiGitStep({ signal, job: "checks-fast-core", fetchResults: [0, 0] });
  expect(report.code).toBe(0);
  expect(
    report.fetches.map(({ cwd, args }) => ({ cwd, blobless: args.includes("--filter=blob:none") })),
  ).toEqual([
    { cwd: report.workspace, blobless: false },
    { cwd: path.join(report.workspace, ".ci-harness"), blobless: true },
  ]);
});

const qaMainFetch = command("fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
const qaBootstrapFetch = command("fetch --no-tags --no-recurse-submodules --depth=1 origin");
// Real topology and protocol-base fetch proof lives in ci-workflow-evidence.test.ts.
posixIt.for([
  { step: "Restore trusted QA harness revision", ref: harness, checkout: harness, selected: false },
  { step: "Checkout selected ref", ref: candidate, checkout: "FETCH_HEAD", selected: true },
])(
  "QA $step checks out the exact revision",
  async ({ step, ref, checkout, selected }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      workflow: { file: ".github/workflows/qa-profile-evidence.yml", job: "plan_qa_profile", step },
      fetchResults: [0],
      realClock: true,
      realDrain: false,
      poisonPython: true,
      env: {
        EXPECTED_SHA: candidate,
        EXPECTED_WORKFLOW_SHA: harness,
        GITHUB_SERVER_URL: "https://github.com",
      },
    });
    expect(report).toMatchObject({ code: 0, readyAttempts: [1], ...noOutputs });
    const cwd = selected ? path.join(report.workspace, "selected") : report.workspace;
    expect(argsOf(report.fetches)).toEqual([[...qaBootstrapFetch, ref]]);
    expect(report.fetches[0]).toMatchObject({ cwd, configuration: [] });
    expect(locations(report.commands.filter(({ args }) => args[0] === "rev-parse"))).toEqual([
      { args: ["rev-parse", "HEAD"], cwd },
    ]);
    expect(locations(report.checkouts)).toEqual([
      { args: ["checkout", "--detach", checkout], cwd },
    ]);
    if (selected) {
      expect(report.commands.map(({ args }) => args[0])).toEqual(
        command("init remote fetch checkout rev-parse"),
      );
      expect(report.commands.slice(0, 2)).toMatchObject([
        { cwd: report.workspace, args: ["init", "selected"] },
        { cwd, args: ["remote", "add", "origin", "https://github.com/fixture/checkout"] },
      ]);
    }
  },
);

const mantisReleaseRef = "release/2026.8.1";
const mantisReleaseFetch = command(
  "fetch --no-tags origin",
  `+refs/heads/${mantisReleaseRef}:refs/remotes/origin/${mantisReleaseRef}`,
);
const mantisCases = [
  { label: "candidate main ancestor", shared: true },
  { label: "baseline before candidate", shared: true, baseline: true },
  { label: "Discord main ancestor", shared: false },
  { label: "Discord exact release branch", shared: false, release: true },
  {
    label: "Discord release mismatch never consults PRs",
    shared: false,
    release: true,
    mismatch: true,
  },
] satisfies {
  label: string;
  shared: boolean;
  baseline?: boolean;
  release?: boolean;
  mismatch?: boolean;
}[];

posixIt.for(mantisCases)("validates Mantis trust: $label", async (profile, { signal }) => {
  const { shared } = profile;
  const baseline = "baseline" in profile && profile.baseline;
  const release = "release" in profile && profile.release;
  const mismatch = "mismatch" in profile && profile.mismatch;
  const fetches = release ? [qaMainFetch, mantisReleaseFetch] : [qaMainFetch];
  const report = await runCiGitStep({
    signal,
    ...(shared
      ? ({ action: "mantis-validate-trusted-ref", step: "Validate refs are trusted" } as const)
      : {
          workflow: {
            file: ".github/workflows/mantis-discord-smoke.yml",
            job: "validate_selected_ref",
            step: "Validate selected ref",
          },
        }),
    fetchResults: fetches.map(() => 0),
    realClock: true,
    realDrain: false,
    poisonPython: true,
    env: {
      BASELINE_REF: baseline ? "baseline" : "",
      CANDIDATE_REF: "candidate",
      INPUT_REF: release ? mantisReleaseRef : "main",
    },
    revisions: {
      "baseline^{commit}": base,
      "candidate^{commit}": candidate,
      [`refs/heads/${mantisReleaseRef}`]: mismatch ? moved : candidate,
    },
    mergeBase: { ancestor: !release, revision: base },
  });
  const code = mismatch ? 1 : 0;
  expect(report).toMatchObject({
    code,
    readyAttempts: attempts(fetches),
    githubEnv: "",
    githubPath: "",
  });
  expect(argsOf(report.fetches)).toEqual(fetches);
  expect(
    report.fetches.every(
      ({ cwd, configuration }) => cwd === report.workspace && configuration?.length === 0,
    ),
  ).toBe(true);
  expect(toolArgs(report, "gh")).toEqual([]);
  if (baseline) {
    expect(toolArgs(report, "git").filter((args) => args[0] === "rev-parse")).toEqual([
      command("rev-parse baseline^{commit}"),
      command("rev-parse candidate^{commit}"),
    ]);
  }
  const reason = release ? "release-branch-head" : "main-ancestor";
  expect(report.githubOutput).toBe(
    code !== 0
      ? ""
      : shared
        ? `${baseline ? `baseline_revision=${base}\n` : ""}candidate_revision=${candidate}\n`
        : `selected_revision=${candidate}\ntrusted_reason=${reason}\n`,
  );
  if (mismatch) {
    expect(report.githubSummary).toBe("");
    expect(report.output).toContain("not trusted for this secret-bearing Mantis run");
  }
});

function mantisWorktree(workflow: string, job: string, offline: boolean, build: boolean) {
  return {
    workflow,
    job,
    offline,
    build,
    lanes: offline ? ["candidate"] : ["baseline", "candidate"],
  };
}
const mantisWorktrees = [
  mantisWorktree("discord-status-reactions", "run_status_reactions", false, true),
  mantisWorktree("slack-desktop-smoke", "run_slack_desktop", true, true),
  mantisWorktree("web-ui-chat-proof", "run_web_ui_chat", true, false),
];

posixIt.for([
  ...mantisWorktrees.map((profile) => ({ ...profile, failure: false })),
  { ...mantisWorktrees[0]!, failure: true },
])(
  "prepares $workflow worktrees (cleanup failure=$failure)",
  async ({ workflow, job, lanes, offline, build, failure }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      workflow: {
        file: `.github/workflows/mantis-${workflow}.yml`,
        job,
        step:
          lanes.length === 2
            ? "Prepare baseline and candidate worktrees"
            : "Prepare candidate worktree",
      },
      fetchResults: [],
      worktreeResults: failure ? ["cleanup-failure"] : lanes.map(() => 0),
      stepOutputs:
        workflow === "web-ui-chat-proof"
          ? { prepare_evidence: { output_dir: "${RUNNER_TEMP}" } }
          : undefined,
      realClock: true,
      realDrain: false,
      poisonPython: true,
      env: { BASELINE_SHA: base, CANDIDATE_SHA: candidate },
    });
    const attempted = failure ? lanes.slice(0, 1) : lanes;
    expect(report).toMatchObject({
      code: failure ? 125 : 0,
      readyAttempts: attempts(attempted),
      clones: [],
      fetches: [],
      ...noOutputs,
    });
    const lanePath = (lane: string) => `.artifacts/qa-e2e/mantis/${workflow}-worktrees/${lane}`;
    expect(report.commands.every(({ cwd }) => cwd === report.workspace)).toBe(true);
    expect(argsOf(report.worktrees)).toEqual(
      attempted.map((lane) =>
        command("worktree add --detach", lanePath(lane), lane === "baseline" ? base : candidate),
      ),
    );
    expect(toolArgs(report, "pnpm")).toEqual(
      failure
        ? []
        : lanes.flatMap((lane) => [
            [
              "--dir",
              lanePath(lane),
              "install",
              "--frozen-lockfile",
              ...(offline ? ["--prefer-offline"] : []),
            ],
            ...(build ? [["--dir", lanePath(lane), "build"]] : []),
          ]),
    );
    expect(report.commands).toHaveLength(
      attempted.length + (failure ? 0 : lanes.length * (build ? 2 : 1)),
    );
    expect(boundaryNames(report)).toEqual([
      ...attempted.map((_, index) => `worktree:${index + 1}`),
      ...(failure
        ? []
        : lanes.flatMap(() => (build ? ["consumer:pnpm", "consumer:pnpm"] : ["consumer:pnpm"]))),
      "exit",
    ]);
    if (failure) {
      expect(report.output).toContain("Git ownership/setup failed");
    }
  },
);

const newer = "d".repeat(40);
const sourceObject = "refs/remotes/origin/main:.openclaw-sync/source.json";
const rebase = command("rebase -X theirs origin/main");
const abort = command("rebase --abort");
const dependencyReads = [
  ["show", "refs/remotes/origin/main:package.json"],
  ["show", "refs/remotes/origin/main:package-lock.json"],
];

function runDocs(signal: AbortSignal, step: string, options: GitOptions = {}) {
  return runCiGitStep({
    signal,
    workflow: { file: ".github/workflows/docs-sync-publish.yml", job: "sync-publish-repo", step },
    fetchResults: [],
    objects: { [sourceObject]: { text: JSON.stringify({ sha: candidate }) } },
    poisonPython: true,
    ...options,
  });
}

type GitReport = Awaited<ReturnType<typeof runCiGitStep>>;
const attempts = (entries: readonly unknown[]) => entries.map((_, index) => index + 1);
const locations = (commands: GitReport["commands"]) =>
  commands.map(({ args, cwd }) => ({ args, cwd }));
const argsOf = (commands: GitReport["commands"]) => commands.map(({ args }) => args);
const lastArgs = (commands: GitReport["commands"]) => commands.map(({ args }) => args.at(-1));
const boundaryNames = (report: GitReport) => report.boundaries.map(({ name }) => name);
const toolArgs = (report: GitReport, tool: string) =>
  argsOf(report.commands.filter((entry) => entry.tool === tool));
const gitArgs = (report: GitReport) => toolArgs(report, "git");
function expectGit(report: GitReport, code: number, commands: string[][]) {
  expect(report.code, report.output).toBe(code);
  expect(gitArgs(report)).toEqual(commands);
}

function backoffs(report: Awaited<ReturnType<typeof runDocs>>) {
  return [...report.output.matchAll(/fixture backoff: (\d+)/gu)].map((match) => Number(match[1]));
}

posixIt.for(["directory", "file", "symlink"] as const)(
  "docs clone drains an ordinary failure before deleting/retrying (%s)",
  async (publishPath, { signal }) => {
    const report = await runDocs(signal, docsClone, {
      cloneResults: [23, 0],
      publishPath,
    });
    expect(report).toMatchObject({ code: 0, readyAttempts: [1, 2] });
    expect(gitArgs(report)).toEqual(
      [1, 2].map(() => [
        "clone",
        "https://x-access-token:fixture-docs-token@github.com/openclaw/docs.git",
        path.join(report.workspace, "publish"),
      ]),
    );
    expect(boundaryNames(report)).toEqual(["delete", "clone:1", "delete", "clone:2", "exit"]);
    expect(backoffs(report)).toEqual([2]);
    expect(report.output).toContain("Clone attempt 1 failed; retrying.");
    expect(report.output).not.toContain("fixture-docs-token");
  },
);

posixIt("stops cloning before deletion when cleanup is uncertain", async ({ signal }) => {
  const report = await runDocs(signal, docsClone, {
    cloneResults: ["cleanup-failure"],
  });
  expect(report).toMatchObject({ code: 125, clones: length(1) });
  expect(boundaryNames(report)).toEqual(["delete", "clone:1", "exit"]);
  expect(backoffs(report)).toEqual([]);
  expect(report.output).toContain("Git ownership/setup failed");
  expect(report.output).not.toContain("fixture-docs-token");
});

posixIt.for([125, "hang"] satisfies FetchResult[])(
  "continues after an advisory docs fetch failure (%s)",
  async (failure, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      fetchResults: [failure, 0],
    });
    expect(report.code, report.output).toBe(0);
    expect(report.pushes).toHaveLength(1);
    expect(backoffs(report)).toEqual([]);
    expect(
      report.commands.every(
        ({ tool, args, cwd }) =>
          cwd ===
          (tool === "node" && args[0] === "--input-type=module"
            ? report.workspace
            : path.join(report.workspace, "publish")),
      ),
    ).toBe(true);
  },
);

posixIt.for([
  { operation: "push", failure: 23, lockChange: true },
  { operation: "rebase", failure: 125, lockChange: false },
  { operation: "push", failure: 143, lockChange: false },
])(
  "retries docs $operation ($failure) after aborting the rebase",
  async ({ operation, failure, lockChange }, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      env: lockChange ? { FIXTURE_DOCS_LOCK_AFTER_REBASE: "1" } : {},
      rebaseResults: operation === "rebase" ? [failure, 0] : [],
      pushResults: operation === "push" ? [failure, 0] : [],
    });
    expect(report.code, report.output).toBe(0);
    expect(argsOf(report.rebases)).toEqual([rebase, abort, rebase]);
    expect(report.pushes).toHaveLength(operation === "push" ? 2 : 1);
    expect(backoffs(report)).toEqual([2]);
    expect(report.output).toContain("Publish sync attempt 1 failed; retrying.");
    expect(report.commands.filter(({ tool }) => tool === "npm")).toHaveLength(lockChange ? 2 : 1);
    if (operation === "push" && !lockChange) {
      expect(report.output).toContain("Reused 1 unchanged successful page check(s).");
    }
  },
);

posixIt("rejects invalid rebased docs before push", async ({ signal }) => {
  const report = await runDocs(signal, docsCommit, {
    env: { FIXTURE_DOCS_MDX_AFTER_REBASE: "# Rebased page\n\n{unfinished\n" },
  });
  expect(report.code, report.output).toBe(125);
  expect(report.output).toContain("Docs MDX check failed");
  expect(report.pushes).toEqual([]);
  expect(argsOf(report.rebases)).toEqual([rebase]);
});

posixIt.for([docsClone, docsCommit])(
  "exhausts docs %s retries with terminal backoff",
  async (step, { signal }) => {
    const cloning = step === docsClone;
    const report = await runDocs(signal, step, {
      cloneResults: cloning ? Array<FetchResult>(5).fill(23) : [],
      fetchResults: cloning ? [] : [0, ...Array<FetchResult>(5).fill(23)],
    });
    expect(report.code, report.output).toBe(1);
    expect(backoffs(report)).toEqual([2, 4, 6, 8, 10]);
    expect(report.clones).toHaveLength(cloning ? 5 : 0);
    expect(report.fetches).toHaveLength(cloning ? 0 : 6);
    expect(argsOf(report.rebases)).toEqual(
      cloning ? [] : Array.from({ length: 5 }, () => [...abort]),
    );
    expect(report.pushes).toEqual([]);
    expect(report.output.trim()).toMatch(
      cloning
        ? /Failed to clone publish repo after retries\.$/u
        : /Failed to push publish-repo sync after retries\.$/u,
    );
  },
);

posixIt.for([
  { label: "no changes", diffResult: 0, stale: false },
  { label: "stale source", diffResult: 1, stale: true },
])(
  "docs publication exits successfully without committing for $label",
  async ({ diffResult, stale }, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      diffResult,
      objects: { [sourceObject]: { text: JSON.stringify({ sha: newer }) } },
      mergeBase: { ancestor: true, revision: candidate },
    });
    expect(report.code, report.output).toBe(0);
    expect(gitArgs(report).some((args) => args[0] === "commit")).toBe(false);
    expect(report.pushes).toEqual([]);
    expect(report.output).toContain(
      stale
        ? `Skipping stale publish sync for ${candidate}; origin/main already mirrors ${newer}.`
        : "No publish-repo changes.",
    );
    if (stale) {
      expect(report.commands.at(-1)?.cwd).toBe(report.workspace);
    }
  },
);

posixIt.for([
  { label: "missing metadata", text: "", code: 128, ancestor: false },
  { label: "malformed JSON", text: "{", code: 0, ancestor: false },
  { label: "non-JSON constant", text: `{"sha":"${newer}","value":NaN}`, code: 0, ancestor: true },
  { label: "JSON with BOM", text: `\uFEFF{"sha":"${newer}"}`, code: 0, ancestor: true },
  { label: "empty source", text: '{"sha":""}', code: 0, ancestor: false },
  { label: "unrelated source", text: JSON.stringify({ sha: newer }), code: 0, ancestor: false },
])(
  "docs publication retains the changed path for $label",
  async ({ text, code, ancestor, label }, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      objects: { [sourceObject]: { text, code } },
      mergeBase: { ancestor, revision: candidate },
    });
    expect(report.code, report.output).toBe(0);
    const staleCheck =
      label === "unrelated source" ? [["merge-base", "--is-ancestor", candidate, newer]] : [];
    expect(gitArgs(report).filter((args) => args[0] === "merge-base")).toEqual([
      ...staleCheck,
      ...staleCheck,
    ]);
    expect(report.pushes).toHaveLength(1);
  },
);

posixIt.for([
  {
    label: "malformed remote manifest",
    text: "{",
    validates: false,
    error: "Git ownership/setup failed (unknown); refusing reuse or retry",
  },
  {
    label: "unrelated remote dependency update lost during rebase",
    text: JSON.stringify({
      name: "docs-fixture",
      private: true,
      devDependencies: { "@sindresorhus/slugify": "2.2.0", "markdown-it": "15.0.1" },
    }),
    validates: true,
    error: "docs sync changed unrelated publisher dependencies",
  },
])("rejects $label before push or retry", async ({ text, validates, error }, { signal }) => {
  const report = await runDocs(signal, docsCommit, {
    objects: {
      [sourceObject]: { text: JSON.stringify({ sha: candidate }) },
      [dependencyReads[0]![1]!]: { text },
    },
  });
  expect(report.code, report.output).toBe(125);
  expect(report.pushes).toEqual([]);
  expect(argsOf(report.rebases)).toEqual([rebase]);
  expect(report.commands.filter(({ tool }) => tool === "node")).toHaveLength(validates ? 1 : 0);
  expect(report.output).toContain(error);
  expect(backoffs(report)).toEqual([]);
});

posixIt.for([0, 23, "cleanup-failure"] satisfies FetchResult[])(
  "docs ClawHub HEAD is owned before Node consumption (%s)",
  async (revParseResult, { signal }) => {
    const report = await runDocs(signal, "Sync docs into publish repo", { revParseResult });
    expect(report.code, report.output).toBe(
      revParseResult === "cleanup-failure" ? 125 : revParseResult,
    );
    expect(gitArgs(report)).toEqual([["rev-parse", "HEAD"]]);
    expect(report.commands[0]?.cwd).toBe(path.join(report.workspace, "clawhub-source"));
    const syncCommand = [
      "scripts/docs-sync-publish.mjs",
      "--target",
      path.join(report.workspace, "publish"),
      ...command(`--source-repo fixture/checkout --source-sha ${candidate}`),
      "--clawhub-repo",
      path.join(report.workspace, "clawhub-source"),
      ...command(`--clawhub-source-repo openclaw/clawhub --clawhub-source-sha ${candidate}`),
    ];
    expect(toolArgs(report, "node")).toEqual(revParseResult === 0 ? [syncCommand] : []);
  },
);

const agentRunsRequest = command(
  "api --method GET repos/fixture/checkout/actions/workflows/docs-agent.yml/runs -f branch=main -f event=workflow_run -f per_page=100",
);
const agentGate = "Gate trusted main activity and hourly cadence";
const agentCommit = "Commit docs updates";
const agentFetch = ["fetch", "--no-tags", "origin", "main"];
const agentPush = command(
  "push https://x-access-token:fixture-docs-agent-token@github.com/fixture/checkout.git HEAD:main",
);
const agentOutput = (reviewBase = base) =>
  `run_agent=true\nbase_sha=${candidate}\nreview_base_sha=${reviewBase}\nreview_head_sha=${candidate}\n`;

function runDocsAgent(signal: AbortSignal, step: string, options: GitOptions = {}) {
  return runCiGitStep({
    signal,
    ...options,
    workflow: { file: ".github/workflows/docs-agent.yml", job: "update-docs", step },
    fetchResults: options.fetchResults ?? [],
    poisonPython: true,
    env: {
      EVENT_NAME: "workflow_run",
      WORKFLOW_HEAD_SHA: candidate,
      GITHUB_RUN_ID: "123",
      GITHUB_TOKEN: "",
      BASE_SHA: candidate,
      ...options.env,
    },
    revisions: { "origin/main": candidate, [`${candidate}^`]: base, ...options.revisions },
  });
}

posixIt.for([0, 128, 125])("admits manual Docs Agent with parent=%s", async (code, { signal }) => {
  const report = await runDocsAgent(signal, agentGate, {
    env: { EVENT_NAME: "workflow_dispatch" },
    commandResults: { "rev-parse HEAD": { code: 0 }, [`rev-parse ${candidate}^`]: { code } },
  });
  expectGit(report, 0, [command("rev-parse HEAD"), command(`rev-parse ${candidate}^`)]);
  expect(toolArgs(report, "gh")).toEqual([]);
  expect(report.githubOutput).toBe(agentOutput(code === 0 ? base : candidate));
});

posixIt("skips superseded Docs Agent before GitHub reads", async ({ signal }) => {
  const report = await runDocsAgent(signal, agentGate, { revisions: { "origin/main": moved } });
  expectGit(report, 0, [agentFetch, ["rev-parse", "origin/main"]]);
  expect(report.githubOutput).toBe("run_agent=false\n");
  expect(toolArgs(report, "gh")).toEqual([]);
  expect(report.output).toContain(
    `CI run is superseded by ${moved}; skipping docs agent for ${candidate}.`,
  );
});

posixIt.for([
  { probe: 128, parent: 0, code: 0, reviewBase: base },
  { probe: 128, parent: 128, code: 0, reviewBase: candidate },
  { probe: 0, parent: 0, code: 0, reviewBase: moved },
] satisfies { probe: FetchResult; parent: FetchResult; code: number; reviewBase: string }[])(
  "resolves Docs Agent review base ($probe/$parent)",
  async ({ probe, parent, code, reviewBase }, { signal }) => {
    const report = await runDocsAgent(signal, agentGate, {
      workflowRuns: [
        {
          id: 122,
          run_attempt: 1,
          created_at: "2026-08-28T20:00:00Z",
          status: "completed",
          conclusion: "success",
          head_sha: moved,
        },
      ],
      workflowJobs: [
        {
          runId: 122,
          runAttempt: 1,
          jobs: [
            {
              name: "update-docs",
              status: "completed",
              conclusion: "success",
              steps: [{ name: "Run Codex docs agent", status: "completed", conclusion: "success" }],
            },
          ],
        },
      ],
      commandResults: {
        [`cat-file -e ${moved}^{commit}`]: { code: probe },
        [`rev-parse ${candidate}^`]: { code: parent },
      },
    });
    expectGit(report, code, [
      agentFetch,
      ["rev-parse", "origin/main"],
      ["cat-file", "-e", `${moved}^{commit}`],
      ...(probe === 128 ? [["rev-parse", `${candidate}^`]] : []),
    ]);
    expect(report.githubOutput).toBe(code === 0 ? agentOutput(reviewBase) : "");
    expect(toolArgs(report, "gh")).toEqual([
      agentRunsRequest,
      command(
        "api --paginate --slurp repos/fixture/checkout/actions/runs/122/attempts/1/jobs?per_page=100",
      ),
    ]);
    expect(backoffs(report)).toEqual([]);
  },
);

posixIt("skips unchanged Docs Agent commits", async ({ signal }) => {
  const report = await runDocsAgent(signal, agentCommit, {
    commandResults: { "diff HEAD --quiet": { code: 0 } },
  });
  expectGit(report, 0, [["diff", "HEAD", "--quiet"]]);
  expect(report.output).toBe("No docs changes.\n");
});

posixIt.for([false, true])(
  "handles rejected Docs Agent pushes (main advanced=%s)",
  async (advanced, { signal }) => {
    const report = await runDocsAgent(signal, agentCommit, {
      pushResults: [143, 0],
      revParseResult: 0,
      revisions: { "origin/main": advanced ? moved : candidate },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(advanced ? 1 : 2);
    expect(argsOf(report.pushes)).toEqual(
      Array.from({ length: advanced ? 1 : 2 }, () => agentPush),
    );
    expect(report.output).not.toContain("fixture-docs-agent-token");
    expect(backoffs(report)).toEqual(advanced ? [] : [2]);
    expect(report.output).toContain(
      advanced
        ? `main advanced from ${candidate} to ${moved}; skipping stale docs update.`
        : "Docs update attempt 1 failed; retrying.",
    );
  },
);

posixIt.for(["gate", "commit fetch", "commit push"])(
  "exhausts Docs Agent %s retries",
  async (phase, { signal }) => {
    const gate = phase === "gate";
    const report = await runDocsAgent(signal, gate ? agentGate : agentCommit, {
      fetchResults: phase === "commit push" ? [] : Array<FetchResult>(5).fill(23),
      pushResults: phase === "commit push" ? Array<FetchResult>(5).fill(23) : [],
    });
    expect(report.code, report.output).toBe(1);
    expect(report.fetches).toHaveLength(5);
    expect(report.pushes).toHaveLength(phase === "commit push" ? 5 : 0);
    expect(backoffs(report)).toEqual(gate ? [2, 4, 6, 8] : [2, 4, 6, 8, 10]);
    const diagnostic = phase === "commit push" ? "Docs update" : "Fetch";
    expect(report.output.match(/(?:Fetch|Docs update) attempt \d failed; retrying\./gu)).toEqual(
      (gate ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]).map(
        (attempt) => `${diagnostic} attempt ${attempt} failed; retrying.`,
      ),
    );
    expect(report.output.trim()).toMatch(
      gate
        ? /Failed to fetch main after retries\.$/u
        : /Failed to push docs updates after retries\.$/u,
    );
  },
);

const agentProducers = [
  ["ls-files", "--others", "--exclude-standard"],
  ["diff", "HEAD", "--name-status", "--diff-filter=AD"],
  ["diff", "--cached", "HEAD", "--name-status", "--diff-filter=AD"],
  ["diff", "HEAD", "--name-only"],
  ["diff", "--cached", "HEAD", "--name-only"],
];
posixIt.for(agentProducers.map((args, index) => ({ args, index })))(
  "rejects partial docs output from failed $args",
  async ({ args, index }, { signal }) => {
    const report = await runDocsAgent(signal, "Enforce existing-docs-only patch", {
      commandResults: { [args.join(" ")]: { code: 23, output: "src/forbidden.ts\n" } },
    });
    expectGit(report, 23, agentProducers.slice(0, index + 1));
    expect(report.output).not.toContain("forbidden");
  },
);

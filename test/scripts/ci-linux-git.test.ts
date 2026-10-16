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
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
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
const resetCases = [
  fetchCase("leader exit", 0, 0),
  fetchCase("timeout recovery", 0, "hang", 0),
  fetchCase("timeouts exhausted", 1, "hang", "hang", "hang", "hang", "hang"),
  fetchCase("unverified cleanup", 125, "cleanup-failure"),
];
linuxIt.for(resetProfiles.flatMap((profile) => resetCases.map((entry) => ({ profile, entry }))))(
  "$profile.job drains descendants before reset/reuse ($entry.label)",
  async (
    { profile: { job, step, target, remote }, entry: { fetchResults, code, attempts } },
    { signal },
  ) => {
    const report = await runCiGitStep({ signal, job, step, fetchResults });
    expect(report).toMatchObject({
      code,
      readyAttempts: length(attempts),
      fetches: length(attempts),
      checkouts: length(code === 0 ? 1 : 0),
    });
    expect(report.boundaries.filter(({ name }) => name === "delete")).toHaveLength(attempts);
    for (const fetch of report.fetches) {
      expect(fetch.args).toEqual(
        expect.arrayContaining([target, "--depth=1", "--no-tags", "--no-recurse-submodules"]),
      );
      expect(fetch.cwd).toBe(
        job === "android" ? report.workspace : path.join(report.workspace, "clawhub-source"),
      );
    }
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

linuxIt.for([
  { phase: "fetch", fetchResults: [23, 0], checkoutResults: [], firstCheckout: false },
  { phase: "checkout", fetchResults: [0, 0], checkoutResults: [23, 0], firstCheckout: true },
])(
  "Android resets only after safely joined $phase failure",
  async ({ fetchResults, checkoutResults, firstCheckout }, { signal }) => {
    const report = await runCiGitStep({ signal, job: "android", fetchResults, checkoutResults });
    expect(report).toMatchObject({ code: 0, readyAttempts: [1, 2] });
    expect(lastArgs(report.fetches)).toEqual([
      `+${candidate}:refs/remotes/origin/ci-target`,
      `+${candidate}:refs/remotes/origin/ci-target`,
    ]);
    expect(
      report.boundaries
        .filter(({ name }) => name === "delete" || name === "checkout" || name.startsWith("fetch:"))
        .map(({ name }) => name),
    ).toEqual([
      "delete",
      "fetch:1",
      ...(firstCheckout ? ["checkout"] : []),
      "delete",
      "fetch:2",
      "checkout",
    ]);
  },
);

const manualProfiles = [
  { job: "preflight", step: "Checkout", depth: 1 },
  { job: "security-fast", step: "Checkout manual target", depth: 2 },
];
linuxIt.for(
  manualProfiles.flatMap((profile) =>
    [
      fetchCase("missing branch", 0, 128, 0),
      fetchCase("timeout is not missing", 124, "hang", "hang", "hang"),
      fetchCase("cleanup is not missing", 125, "cleanup-failure"),
    ].map((entry) => Object.assign({}, profile, entry)),
  ),
)(
  "$job only falls back after a safely joined unavailable target ($label)",
  async ({ job, step, depth, fetchResults, code }, { signal }) => {
    const report = await runCiGitStep({
      signal,
      job,
      step,
      fetchResults,
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: "refs/heads/missing" },
    });
    expect(report.code).toBe(code);
    const targetFetches = report.fetches.filter(({ args }) =>
      args.some((arg) => arg.endsWith(":refs/remotes/origin/checkout")),
    );
    expect(targetFetches.map(({ args }) => args.at(-1))).toEqual(
      code === 0
        ? [
            "+refs/heads/missing:refs/remotes/origin/checkout",
            `+${candidate}:refs/remotes/origin/checkout`,
          ]
        : fetchResults.map(() => "+refs/heads/missing:refs/remotes/origin/checkout"),
    );
    expect(targetFetches.every(({ args }) => args.includes(`--depth=${depth}`))).toBe(true);
    expect(report.fetches).toHaveLength(
      targetFetches.length + (job === "preflight" && code === 0 ? 1 : 0),
    );
    expect(report.checkouts).toHaveLength(code === 0 ? 1 : 0);
  },
);

linuxIt(
  "preflight pins a moved exact SHA and retries only its parent metadata",
  async ({ signal }) => {
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
      ["checkout", "--detach", "refs/remotes/origin/checkout"],
    ]);
  },
);

linuxIt("manual security never refetches an unavailable equal fallback", async ({ signal }) => {
  const report = await runCheckout(signal, "security-fast", [128], {
    step: "Checkout manual target",
    env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
  });
  expect(report.code).toBe(128);
  expect(lastArgs(report.fetches)).toEqual([`+${candidate}:refs/remotes/origin/checkout`]);
  expect(report.checkouts).toEqual([]);
});

linuxIt(
  "preflight rejects a fallback that cannot satisfy the requested exact SHA",
  async ({ signal }) => {
    const report = await runCheckout(signal, "preflight", [128, 0], {
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: moved },
    });
    expect(report.code).toBe(1);
    expect(lastArgs(report.fetches)).toEqual([
      `+${moved}:refs/remotes/origin/checkout`,
      `+${candidate}:refs/remotes/origin/checkout`,
    ]);
    expect(report.checkouts).toEqual([]);
  },
);

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

linuxIt.for(
  historyProfiles.flatMap((profile) =>
    [
      fetchCase("successful leader exit", 0, 0),
      fetchCase("unverified cleanup", 125, "cleanup-failure"),
    ].map((entry) => Object.assign({}, profile, entry)),
  ),
)(
  "$job/$step joins supplemental history before consumption ($label, $target)",
  async ({ job, step, env, target, fetchResults, code }, { signal }) => {
    const report = await runCheckout(signal, job, fetchResults, {
      step,
      env,
      prepare: true,
      poisonPython: true,
    });
    expect(report).toMatchObject({ code, fetches: length(1) });
    expect(report.fetches[0]?.args).toEqual(expect.arrayContaining([target, "--depth=2"]));
    if (step === "Resolve exact diff base") {
      expect(report.githubOutput).toBe(code === 0 ? `sha=${base}\nhead_sha=${merge}\n` : "");
    }
    if (step === "Prepare release-gate ratchet merge tree") {
      expect(report.githubEnv).toBe(code === 0 ? `RATCHET_BASE_REF=${base}\n` : "");
      expect(lastArgs(report.checkouts)).toEqual(code === 0 ? [merge] : []);
    }
  },
);

linuxIt(
  "ratchet retries a stale merge parent before checkout and base publication",
  async ({ signal }) => {
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
  },
);

posixIt("fetches the CI harness without a second full-repository snapshot", async ({ signal }) => {
  const report = await runCiGitStep({ signal, job: "checks-fast-core", fetchResults: [0, 0] });
  expect(report.code).toBe(0);
  const harnessDirectory = path.join(report.workspace, ".ci-harness");
  const harnessCommands = report.commands.filter(
    ({ tool, cwd }) => tool === "git" && cwd === harnessDirectory,
  );
  expect(harnessCommands.map(({ args }) => args[0])).toEqual(
    command("init remote sparse-checkout fetch checkout"),
  );
  expect(harnessCommands.find(({ args }) => args[0] === "fetch")?.args).toEqual(
    expect.arrayContaining(["--filter=blob:none", `+${harness}:refs/remotes/origin/ci-harness`]),
  );
  expect(harnessCommands.find(({ args }) => args[0] === "fetch")?.args.at(-1)).toBe(
    `+${harness}:refs/remotes/origin/ci-harness`,
  );
  expect(harnessCommands.find(({ args }) => args[0] === "sparse-checkout")?.args).toEqual(
    expect.arrayContaining(
      [
        "scripts/ci-npm-lock-admission.mjs",
        "scripts/generate-npm-package-lock.mjs",
        "scripts/generate-npm-package-lock.mts",
        "scripts/changed-lanes.mts",
        "scripts/lib/merge-head-diff-base.mjs",
        "scripts/stage-openclaw-bun.sh",
        "scripts/lib/openclaw-bun.json",
      ].map((file) => `/${file}`),
    ),
  );
  expect(report.fetches.find(({ cwd }) => cwd === report.workspace)).toMatchObject({
    args: expect.not.arrayContaining(["--filter=blob:none"]),
  });
});

type QaGitCase = {
  label: string;
  job: string;
  step: string;
  env?: Record<string, string>;
  fetches: string[][];
  readbacks: string[];
  checkout?: string;
  selected?: boolean;
  reason?: string;
};
const qaMainFetch = command("fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
const qaBootstrapFetch = command("fetch --no-tags --no-recurse-submodules --depth=1 origin");
const qaValidation = { job: "validate_selected_ref", step: "Validate selected ref" };
const qaPlan = { job: "plan_qa_profile", readbacks: ["HEAD"] };
function releaseValidation(input: string, remote: string, reason: string): QaGitCase {
  return {
    label: reason,
    ...qaValidation,
    env: { INPUT_REF: input },
    fetches: [qaMainFetch, command("fetch --no-tags origin", `+${input}:${remote}`)],
    readbacks: ["HEAD", remote.startsWith("refs/tags/") ? `${remote}^{commit}` : remote],
    reason,
  };
}
function qaCheckout(
  label: string,
  step: string,
  ref: string,
  checkout: string,
  selected = false,
): QaGitCase {
  return { label, ...qaPlan, step, fetches: [[...qaBootstrapFetch, ref]], checkout, selected };
}
const qaGitCases: QaGitCase[] = [
  {
    label: "main validation",
    ...qaValidation,
    fetches: [qaMainFetch],
    readbacks: ["HEAD", `${candidate}^1`],
    reason: "main-ancestor",
  },
  releaseValidation("refs/tags/v2026.8.1", "refs/tags/v2026.8.1", "release-tag"),
  releaseValidation(
    "refs/heads/release/2026.8.1",
    "refs/remotes/origin/release/2026.8.1",
    "release-branch-head",
  ),
  qaCheckout("trusted harness restore", "Restore trusted QA harness revision", harness, harness),
  qaCheckout("selected checkout", "Checkout selected ref", candidate, "FETCH_HEAD", true),
  {
    label: "protocol comparison base",
    job: "run_qa_profile_shard",
    step: "Fetch protocol comparison base",
    fetches: [[...qaBootstrapFetch, `+${base}:refs/remotes/origin/qa-protocol-base`]],
    readbacks: ["refs/remotes/origin/qa-protocol-base^{commit}"],
    selected: true,
  },
];

function runQaGitCase(signal: AbortSignal, profile: QaGitCase, fetchResults: FetchResult[]) {
  return runCiGitStep({
    signal,
    workflow: {
      file: ".github/workflows/qa-profile-evidence.yml",
      job: profile.job,
      step: profile.step,
    },
    fetchResults,
    realClock: true,
    realDrain: false,
    poisonPython: true,
    env: {
      EXPECTED_SHA: candidate,
      EXPECTED_WORKFLOW_SHA: harness,
      INPUT_REF: "main",
      GITHUB_SERVER_URL: "https://github.com",
      ...profile.env,
    },
    revisions: {
      [`${candidate}^1`]: base,
      "refs/tags/v2026.8.1": candidate,
      "refs/tags/v2026.8.1^{commit}": candidate,
      "refs/heads/release/2026.8.1": candidate,
      "refs/remotes/origin/qa-protocol-base^{commit}": base,
    },
    mergeBase: { ancestor: true, revision: base },
    baseAvailableAfter: 0,
  });
}

posixIt.for(qaGitCases)(
  "QA Git owner drains descendants before the next boundary: $label",
  async (profile, { signal }) => {
    const report = await runQaGitCase(
      signal,
      profile,
      profile.fetches.map(() => 0),
    );
    expect(report).toMatchObject({
      code: 0,
      readyAttempts: attempts(profile.fetches),
      githubEnv: "",
      githubPath: "",
    });
    expect(argsOf(report.fetches)).toEqual(profile.fetches);
    const cwd = profile.selected ? path.join(report.workspace, "selected") : report.workspace;
    expect(
      report.fetches.every((fetch) => fetch.cwd === cwd && fetch.configuration?.length === 0),
    ).toBe(true);
    expect(locations(report.commands.filter(({ args }) => args[0] === "rev-parse"))).toEqual(
      profile.readbacks.map((ref) => ({ args: ["rev-parse", ref], cwd })),
    );
    expect(locations(report.checkouts)).toEqual(
      profile.checkout ? [{ args: ["checkout", "--detach", profile.checkout], cwd }] : [],
    );
    if (profile.step === "Checkout selected ref") {
      expect(report.commands.map(({ args }) => args[0])).toEqual(
        command("init remote fetch checkout rev-parse"),
      );
      expect(report.commands.slice(0, 2)).toMatchObject([
        { cwd: report.workspace, args: ["init", "selected"] },
        { cwd, args: ["remote", "add", "origin", "https://github.com/fixture/checkout"] },
      ]);
    }
    expect(report.githubOutput).toBe(
      profile.reason
        ? `protocol_base_revision=${base}\nselected_revision=${candidate}\ntrusted_reason=${profile.reason}\n`
        : "",
    );
    if (profile.reason) {
      expect(report.githubSummary).toContain(`Trust reason: \`${profile.reason}\``);
      expect(report.githubSummary).toContain(`Protocol base: \`${base}\``);
    }
  },
);

posixIt.for(qaGitCases.filter(({ label, reason }) => !reason || label === "main validation"))(
  "QA Git owner stops without downstream work after cleanup failure: $label",
  async (profile, { signal }) => {
    const report = await runQaGitCase(signal, profile, ["cleanup-failure"]);
    expect(report).toMatchObject({ code: 125, readyAttempts: [1], checkouts: [], ...noOutputs });
    expect(argsOf(report.fetches)).toEqual([profile.fetches[0]]);
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
    expect(argsOf(report.commands.filter(({ args }) => args[0] === "rev-parse"))).toEqual(
      profile.reason ? [["rev-parse", "HEAD"]] : [],
    );
    expect(report.output).toContain("Git ownership/setup failed");
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

posixIt.for([
  ...mantisCases.map((entry) => Object.assign({}, entry, { failure: 0 as FetchResult })),
  ...[true, false].flatMap((shared) =>
    (["cleanup-failure", 23] satisfies FetchResult[]).map((failure) => ({
      label: `${shared ? "shared action" : "Discord"} terminal ${failure}`,
      shared,
      failure,
    })),
  ),
])(
  "Mantis ref Git owner drains before trust probes and publication: $label",
  async (profile, { signal }) => {
    const { shared, failure } = profile;
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
      fetchResults: failure ? [failure] : fetches.map(() => 0),
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
    const code = failure === "cleanup-failure" ? 125 : failure || (mismatch ? 1 : 0);
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
    expect(report.commands.filter(({ tool }) => tool === "gh")).toEqual([]);
    const probes = failure
      ? []
      : [
          ...(baseline
            ? [
                ["rev-parse", "baseline^{commit}"],
                ["merge-base", "--is-ancestor", base, "refs/remotes/origin/main"],
              ]
            : []),
          ...(shared ? [["rev-parse", "candidate^{commit}"]] : []),
          ["merge-base", "--is-ancestor", candidate, "refs/remotes/origin/main"],
          ...(release
            ? [
                ["tag", "--points-at", candidate],
                mantisReleaseFetch,
                ["rev-parse", `refs/remotes/origin/${mantisReleaseRef}`],
              ]
            : []),
        ];
    expect(argsOf(report.commands)).toEqual([
      ...(!shared ? [["rev-parse", "HEAD"]] : []),
      qaMainFetch,
      ...probes,
    ]);
    const reason = release ? "release-branch-head" : "main-ancestor";
    expect(report.githubOutput).toBe(
      code !== 0
        ? ""
        : shared
          ? `${baseline ? `baseline_revision=${base}\n` : ""}candidate_revision=${candidate}\n`
          : `selected_revision=${candidate}\ntrusted_reason=${reason}\n`,
    );
    expect(report.githubSummary).toBe(
      code !== 0
        ? ""
        : shared
          ? `${baseline ? `baseline: \`baseline\`\nbaseline SHA: \`${base}\`\nbaseline trust reason: \`main-ancestor\`\n` : ""}candidate: \`candidate\`\ncandidate SHA: \`${candidate}\`\ncandidate trust reason: \`main-ancestor\`\n`
          : `Validated ref: \`${release ? mantisReleaseRef : "main"}\`\nResolved SHA: \`${candidate}\`\nTrust reason: \`${reason}\`\n`,
    );
    if (failure === "cleanup-failure") {
      expect(report.output).toContain("Git ownership/setup failed");
    }
    if (mismatch) {
      expect(report.output).toContain("not trusted for this secret-bearing Mantis run");
    }
  },
);

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
  "Mantis worktree Git owner drains before next worktree/install/build: $workflow (cleanup failure=$failure)",
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
    const record = (tool: string, args: string[]) => ({ tool, cwd: report.workspace, args });
    expect(report.worktrees).toEqual(
      attempted.map((lane) => ({
        ...record(
          "git",
          command("worktree add --detach", lanePath(lane), lane === "baseline" ? base : candidate),
        ),
        configuration: [],
      })),
    );
    expect(report.commands.filter(({ tool }) => tool === "pnpm")).toEqual(
      failure
        ? []
        : lanes.flatMap((lane) => [
            record("pnpm", [
              "--dir",
              lanePath(lane),
              "install",
              "--frozen-lockfile",
              ...(offline ? ["--prefer-offline"] : []),
            ]),
            ...(build ? [record("pnpm", ["--dir", lanePath(lane), "build"])] : []),
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
const fetch = command("fetch origin main:refs/remotes/origin/main");
const show = ["show", sourceObject];
const rebase = command("rebase -X theirs origin/main");
const push = command("push origin HEAD:main");
const abort = command("rebase --abort");
const diff = command("diff --quiet -- docs .openclaw-sync package.json package-lock.json");
const dependencyReads = [
  ["show", "refs/remotes/origin/main:package.json"],
  ["show", "refs/remotes/origin/main:package-lock.json"],
];
const commit = [
  ["config", "user.name", "openclaw-docs-sync[bot]"],
  ["config", "user.email", "openclaw-docs-sync[bot]@users.noreply.github.com"],
  ["add", "docs", ".openclaw-sync", "package.json", "package-lock.json"],
  ["commit", "-m", `chore(sync): mirror docs from fixture/checkout@${candidate}`],
];

const publishAttempt = [fetch, show, rebase, ...dependencyReads, push];
const committed = [diff, fetch, show, ...commit];

function runDocs(
  signal: AbortSignal,
  step: string,
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
) {
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

posixIt(
  "docs clone cleanup uncertainty is terminal before another deletion or clone",
  async ({ signal }) => {
    const report = await runDocs(signal, docsClone, {
      cloneResults: ["cleanup-failure"],
    });
    expect(report).toMatchObject({ code: 125, clones: length(1) });
    expect(boundaryNames(report)).toEqual(["delete", "clone:1", "exit"]);
    expect(backoffs(report)).toEqual([]);
    expect(report.output).toContain("Git ownership/setup failed");
    expect(report.output).not.toContain("fixture-docs-token");
  },
);

posixIt.for([125, "hang"] satisfies FetchResult[])(
  "docs advisory fetch drains before config/add/commit and still continues (%s)",
  async (failure, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      fetchResults: [failure, 0],
    });
    expectGit(report, 0, [diff, fetch, ...commit, ...publishAttempt]);
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
    expect(report.commands.filter(({ tool }) => tool === "node")).toHaveLength(2);
    expect(boundaryNames(report)).toEqual([
      ...command("diff fetch:1 config config add commit fetch:2"),
      `show:${sourceObject}`,
      "rebase:1",
      ...dependencyReads.map((args) => `show:${args[1]}`),
      ...command("consumer:node consumer:npm consumer:node push:1 exit"),
    ]);
  },
);

posixIt.for([
  { operation: "push", failure: 23, lockChange: true },
  { operation: "rebase", failure: 125, lockChange: false },
  { operation: "push", failure: 143, lockChange: false },
])(
  "docs publication drains failed $operation ($failure) before abort/next fetch and then succeeds",
  async ({ operation, failure, lockChange }, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      env: lockChange ? { FIXTURE_DOCS_LOCK_AFTER_REBASE: "1" } : {},
      rebaseResults: operation === "rebase" ? [failure, 0] : [],
      pushResults: operation === "push" ? [failure, 0] : [],
    });
    expectGit(report, 0, [
      ...committed,
      fetch,
      show,
      rebase,
      ...(operation === "push" ? [...dependencyReads, push] : []),
      abort,
      ...publishAttempt,
    ]);
    expect(backoffs(report)).toEqual([2]);
    expect(report.output).toContain("Publish sync attempt 1 failed; retrying.");
    expect(report.commands.filter(({ tool }) => tool === "npm")).toHaveLength(lockChange ? 2 : 1);
    if (operation === "push" && !lockChange) {
      expect(report.output).toContain("Reused 1 unchanged successful page check(s).");
    }
  },
);

posixIt(
  "docs publication rejects invalid content introduced by the final rebase",
  async ({ signal }) => {
    const report = await runDocs(signal, docsCommit, {
      env: { FIXTURE_DOCS_MDX_AFTER_REBASE: "# Rebased page\n\n{unfinished\n" },
    });
    expect(report.code, report.output).toBe(125);
    expect(report.output).toContain("Docs MDX check failed");
    expect(report.pushes).toEqual([]);
    expect(argsOf(report.rebases)).toEqual([rebase]);
  },
);

posixIt.for(["advisory fetch", "fetch", "rebase", "manifest", "lock", "push"] as const)(
  "docs publication cleanup uncertainty at %s prevents abort/retry/next Git",
  async (operation, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      fetchResults:
        operation === "advisory fetch"
          ? ["cleanup-failure"]
          : operation === "fetch"
            ? [0, "cleanup-failure"]
            : [],
      rebaseResults: operation === "rebase" ? ["cleanup-failure"] : [],
      pushResults: operation === "push" ? ["cleanup-failure"] : [],
      commandResults:
        operation === "manifest" || operation === "lock"
          ? {
              [dependencyReads[operation === "manifest" ? 0 : 1]!.join(" ")]: {
                code: "cleanup-failure",
              },
            }
          : {},
    });
    expect(report.code, report.output).toBe(125);
    const stop = { "advisory fetch": 2, fetch: 8, rebase: 10, manifest: 11, lock: 12, push: 13 };
    expect(gitArgs(report)).toEqual([...committed, ...publishAttempt].slice(0, stop[operation]));
    expect(backoffs(report)).toEqual([]);
    expect(report.output).toContain("Git ownership/setup failed");
    expect(report.output).not.toContain("retrying");
  },
);

posixIt.for([docsClone, docsCommit])(
  "docs %s preserves five attempts and every backoff including the terminal one",
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
    expect(
      report.output
        .trim()
        .endsWith(
          cloning
            ? "Failed to clone publish repo after retries."
            : "Failed to push publish-repo sync after retries.",
        ),
    ).toBe(true);
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
    expectGit(
      report,
      0,
      stale ? [diff, fetch, show, ["merge-base", "--is-ancestor", candidate, newer]] : [diff],
    );
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
    expect(gitArgs(report)).toEqual([
      diff,
      fetch,
      show,
      ...staleCheck,
      ...commit,
      fetch,
      show,
      ...staleCheck,
      rebase,
      ...dependencyReads,
      push,
    ]);
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
])(
  "docs publication rejects $label before push without Git retries",
  async ({ text, validates, error }, { signal }) => {
    const report = await runDocs(signal, docsCommit, {
      objects: {
        [sourceObject]: { text: JSON.stringify({ sha: candidate }) },
        [dependencyReads[0]![1]!]: { text },
      },
    });
    expectGit(report, 125, [
      ...committed,
      fetch,
      show,
      rebase,
      ...dependencyReads.slice(0, validates ? 2 : 1),
    ]);
    expect(report.commands.filter(({ tool }) => tool === "node")).toHaveLength(validates ? 1 : 0);
    expect(report.output).toContain(error);
    expect(backoffs(report)).toEqual([]);
  },
);

posixIt.for([0, 23, "cleanup-failure"] satisfies FetchResult[])(
  "docs ClawHub HEAD is owned before Node consumption (%s)",
  async (revParseResult, { signal }) => {
    const report = await runDocs(signal, "Sync docs into publish repo", { revParseResult });
    expect(report.code, report.output).toBe(
      revParseResult === "cleanup-failure" ? 125 : revParseResult,
    );
    expect(gitArgs(report)).toEqual([["rev-parse", "HEAD"]]);
    expect(report.commands[0]?.cwd).toBe(path.join(report.workspace, "clawhub-source"));
    expect(toolArgs(report, "node")).toEqual(
      revParseResult === 0
        ? [
            [
              "scripts/docs-sync-publish.mjs",
              "--target",
              path.join(report.workspace, "publish"),
              "--source-repo",
              "fixture/checkout",
              "--source-sha",
              candidate,
              "--clawhub-repo",
              path.join(report.workspace, "clawhub-source"),
              "--clawhub-source-repo",
              "openclaw/clawhub",
              "--clawhub-source-sha",
              candidate,
            ],
          ]
        : [],
    );
  },
);

posixIt.for([docsClone, docsCommit])(
  "docs %s cancellation never reaches retry, abort, or the next Git call",
  async (step, { signal }) => {
    const report = await runDocs(signal, step, {
      scenario: "cancel-SIGTERM",
      cloneResults: ["hang"],
      fetchResults: ["hang"],
      cooperativeTrees: true,
      realClock: true,
    });
    expect(report.code, report.output).toBe(143);
    expect(report.readyAttempts).toEqual([1]);
    expect(report.commands.filter(({ tool }) => tool === "git")).toHaveLength(
      step === docsClone ? 1 : 2,
    );
    expect(report.rebases).toEqual([]);
    expect(report.pushes).toEqual([]);
    expect(report.output).not.toContain("retrying");
    expect(report.boundaries.filter(({ name }) => name === "delete")).toHaveLength(
      step === docsClone ? 1 : 0,
    );
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
const agentCommitCommands = [
  ["diff", "HEAD", "--quiet"],
  ["config", "user.name", "openclaw-docs-agent[bot]"],
  ["config", "user.email", "openclaw-docs-agent[bot]@users.noreply.github.com"],
  ["add", "docs", "README.md", "CHANGELOG"],
  ["commit", "--no-verify", "-m", "docs: refresh documentation"],
];
const agentOutput = (reviewBase = base) =>
  `run_agent=true\nbase_sha=${candidate}\nreview_base_sha=${reviewBase}\nreview_head_sha=${candidate}\n`;

function runDocsAgent(
  signal: AbortSignal,
  step: string,
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
) {
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

posixIt.for([0, 128, 125])(
  "Docs Agent manual gate owns HEAD and parent before exact outputs (parent=%s)",
  async (code, { signal }) => {
    const report = await runDocsAgent(signal, agentGate, {
      env: { EVENT_NAME: "workflow_dispatch" },
      commandResults: { "rev-parse HEAD": { code: 0 }, [`rev-parse ${candidate}^`]: { code } },
    });
    expectGit(report, 0, [
      ["rev-parse", "HEAD"],
      ["rev-parse", `${candidate}^`],
    ]);
    expect(toolArgs(report, "gh")).toEqual([]);
    expect(report.githubOutput).toBe(agentOutput(code === 0 ? base : candidate));
  },
);

posixIt.for([125, "hang"] satisfies FetchResult[])(
  "Docs Agent gate drains failed fetch before retry, remote read, gh and output (%s)",
  async (failure, { signal }) => {
    const report = await runDocsAgent(signal, agentGate, { fetchResults: [failure, 0] });
    expect(report.code, report.output).toBe(0);
    expect(argsOf(report.fetches)).toEqual([agentFetch, agentFetch]);
    expect(backoffs(report)).toEqual([2]);
    expect(report.output).toContain("Fetch attempt 1 failed; retrying.");
    expect(report.githubOutput).toBe(agentOutput());
    expect(toolArgs(report, "gh")).toEqual([agentRunsRequest]);
  },
);

posixIt.for([false, true])(
  "Docs Agent gate stops before gh/output/retry on fatal cleanup (cancel=%s)",
  async (cancel, { signal }) => {
    const report = await runDocsAgent(signal, agentGate, {
      fetchResults: cancel ? ["hang"] : ["cleanup-failure"],
      ...(cancel ? { scenario: "cancel-SIGTERM", cooperativeTrees: true, realClock: true } : {}),
    });
    expectGit(report, cancel ? 143 : 125, [agentFetch]);
    expect(toolArgs(report, "gh")).toEqual([]);
    expect(report.githubOutput).toBe("");
    expect(backoffs(report)).toEqual([]);
    expect(report.output).not.toContain("retrying");
  },
);

posixIt("Docs Agent superseded gate drains before false output without gh", async ({ signal }) => {
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
  { probe: "cleanup-failure", parent: 0, code: 125, reviewBase: "" },
  { probe: 128, parent: "cleanup-failure", code: 125, reviewBase: "" },
] satisfies { probe: FetchResult; parent: FetchResult; code: number; reviewBase: string }[])(
  "Docs Agent review base only falls back after ordinary Git failure ($probe/$parent)",
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
      [
        "api",
        "--paginate",
        "--slurp",
        "repos/fixture/checkout/actions/runs/122/attempts/1/jobs?per_page=100",
      ],
    ]);
    expect(backoffs(report)).toEqual([]);
  },
);

posixIt("Docs Agent no-change commit owns diff before successful exit", async ({ signal }) => {
  const report = await runDocsAgent(signal, agentCommit, {
    commandResults: { "diff HEAD --quiet": { code: 0 } },
  });
  expectGit(report, 0, [["diff", "HEAD", "--quiet"]]);
  expect(report.output).toBe("No docs changes.\n");
});

posixIt.for([125, "hang"] satisfies FetchResult[])(
  "Docs Agent commit drains diff before config/commit and failed fetch before retry (%s)",
  async (failure, { signal }) => {
    const report = await runDocsAgent(signal, agentCommit, {
      commandResults: { "diff HEAD --quiet": { code: failure === 125 ? 125 : 1 } },
      fetchResults: [failure, 0],
    });
    expectGit(report, 0, [...agentCommitCommands, agentFetch, agentFetch, agentPush]);
    expect(backoffs(report)).toEqual([2]);
    expect(report.output).toContain("Fetch attempt 1 failed; retrying.");
    expect(report.output).not.toContain("fixture-docs-agent-token");
  },
);

posixIt.for([false, true])(
  "Docs Agent push failure drains before owned read and retry/stale success (advanced=%s)",
  async (advanced, { signal }) => {
    const report = await runDocsAgent(signal, agentCommit, {
      pushResults: [143, 0],
      revParseResult: 0,
      revisions: { "origin/main": advanced ? moved : candidate },
    });
    expectGit(report, 0, [
      ...agentCommitCommands,
      agentFetch,
      agentPush,
      ["rev-parse", "origin/main"],
      ...(advanced ? [] : [agentFetch, agentPush]),
    ]);
    expect(backoffs(report)).toEqual(advanced ? [] : [2]);
    expect(report.output).toContain(
      advanced
        ? `main advanced from ${candidate} to ${moved}; skipping stale docs update.`
        : "Docs update attempt 1 failed; retrying.",
    );
  },
);

posixIt.for(["diff", "config", "commit", "fetch", "push", "read"])(
  "Docs Agent commit cleanup failure at %s is terminal before retry/stale success",
  async (operation, { signal }) => {
    const index = operation === "diff" ? 0 : operation === "config" ? 1 : 4;
    const report = await runDocsAgent(signal, agentCommit, {
      commandResults: ["diff", "config", "commit"].includes(operation)
        ? { [agentCommitCommands[index]!.join(" ")]: { code: "cleanup-failure" } }
        : {},
      fetchResults: operation === "fetch" ? ["cleanup-failure"] : [],
      pushResults: operation === "push" ? ["cleanup-failure"] : operation === "read" ? [23] : [],
      revParseResult: operation === "read" ? "cleanup-failure" : undefined,
      revisions: { "origin/main": moved },
    });
    expectGit(
      report,
      125,
      ["diff", "config", "commit"].includes(operation)
        ? agentCommitCommands.slice(0, index + 1)
        : [
            ...agentCommitCommands,
            agentFetch,
            ...(operation === "fetch" ? [] : [agentPush]),
            ...(operation === "read" ? [["rev-parse", "origin/main"]] : []),
          ],
    );
    expect(backoffs(report)).toEqual([]);
    expect(report.output).not.toMatch(/retrying|skipping stale|No docs changes/u);
  },
);

posixIt.for(["gate", "commit fetch", "commit push"])(
  "Docs Agent %s preserves five attempts and terminal backoff contract",
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
    expect(
      report.output
        .trim()
        .endsWith(
          gate
            ? "Failed to fetch main after retries."
            : "Failed to push docs updates after retries.",
        ),
    ).toBe(true);
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
  "Docs Agent enforcement stops on failed producer $args before consuming partial output",
  async ({ args, index }, { signal }) => {
    const report = await runDocsAgent(signal, "Enforce existing-docs-only patch", {
      commandResults: { [args.join(" ")]: { code: 23, output: "src/forbidden.ts\n" } },
    });
    expectGit(report, 23, agentProducers.slice(0, index + 1));
    expect(report.output).not.toContain("forbidden");
  },
);

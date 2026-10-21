import { beforeAll, expect, it, vi } from "vitest";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import type { PerformanceFixtureOptions } from "./openclaw-performance-workflow.test-support.js";

// Each case owns its checkout; bound simultaneous process trees.
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

// Native Windows Job Object proof belongs to ci-platform-checkout.
const posixIt = it.skipIf(process.platform === "win32").concurrent;

const steps = {
  target: ["resolve_target", "Resolve OpenClaw target ref"],
  record: ["source_performance", "Record source performance revision"],
  tested: ["kova", "Record tested revision"],
  kova: ["kova", "Install OCM and Kova"],
  baseline: ["source_performance", "Fetch previous source performance baseline"],
  prepare: ["publish", "Prepare clawgrit report commit"],
  publish: ["publish", "Publish to clawgrit reports"],
} as const;

function performanceRun(
  signal: AbortSignal,
  mode: PerformanceFixtureOptions["mode"],
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
) {
  const [job, step] = steps[mode];
  return runCiGitStep({
    signal,
    workflow: { file: ".github/workflows/openclaw-performance.yml", job, step },
    fetchResults: [],
    performance: { mode },
    ...options,
    env: { QUALIFICATION_DISPATCH: "false", ...options.env },
  });
}

function expectReport(
  report: Awaited<ReturnType<typeof performanceRun>>,
  code: number,
  counts: Partial<Record<"pushes" | "fetches" | "checkouts" | "readyAttempts", number>>,
) {
  expect(report.code, report.output).toBe(code);
  for (const key of ["pushes", "fetches", "checkouts", "readyAttempts"] as const) {
    if (counts[key] !== undefined) {
      expect(report[key]).toHaveLength(counts[key]);
    }
  }
}

// Real workflow bodies must drain writers while an unrelated sentinel stays alive.
posixIt.for(Object.keys(steps) as PerformanceFixtureOptions["mode"][])(
  "Performance %s drains Git trees before every continuation",
  { timeout: 55_000 },
  async (mode, { signal }) => {
    const report = await performanceRun(signal, mode, {
      performance: { mode, successfulGitTrees: true },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.readyAttempts.length).toBeGreaterThan(0);
    if (mode === "prepare") {
      expect(report.githubOutput).toContain("ready=true\n");
    }
    if (mode === "publish") {
      expect(report.pushes).toHaveLength(1);
      expect(report.fetches).toHaveLength(0);
      expect(report.githubSummary).toContain("### Clawgrit report published");
    }
  },
);

posixIt.for([23, 125])(
  "baseline ordinary fetch %s is advisory after extinction",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await performanceRun(signal, "baseline", { fetchResults: [code, code, code] });
    expect(report.code, report.output).toBe(0);
    expect(report.githubSummary).toBe(
      "No previous source performance baseline could be fetched.\n",
    );
    expect(report.githubEnv).toBe("");
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
  },
);

posixIt.for(["absent", "invalid", "trailing-newline"] as const)(
  "baseline %s pointer preserves advisory result",
  { timeout: 55_000 },
  async (baseline, { signal }) => {
    const report = await performanceRun(signal, "baseline", {
      performance: { mode: "baseline", baseline },
    });
    expectReport(report, 0, { checkouts: 0 });
    expect(report.githubSummary).toContain(
      baseline === "absent"
        ? "No previous source performance baseline exists"
        : "Previous source performance baseline pointer is invalid.",
    );
    expect(report.githubEnv).toBe("");
  },
);

posixIt.for([
  ["baseline", "ls-tree", 128],
  ["baseline", "show", 128],
  ["prepare", "ls-tree", 128],
  ["prepare", "ls-tree", 125],
  ["publish", "ls-tree", 125],
  ["publish", "ls-tree", 128],
] as const)(
  "%s %s failure %s is terminal, never absence",
  { timeout: 55_000 },
  async ([mode, operation, code], { signal }) => {
    const report = await performanceRun(signal, mode, {
      gitFault: { match: `^${operation} `, code },
      ...(mode === "publish" ? { pushResults: [23] } : {}),
    });
    expect(report, report.output).toMatchObject({
      code,
      ...(mode === "baseline" ? { githubSummary: "", githubEnv: "" } : {}),
      ...(mode === "prepare" ? { githubOutput: "ready=false\n" } : {}),
      ...(mode === "publish" ? { githubSummary: "", checkouts: [] } : {}),
    });
    expect(report.commands.at(-1)?.args[0]).toBe(operation);
  },
);

posixIt.for(["hang", 23, 125] as const)(
  "prepare initial fetch %s cannot reach checkout, commit or token readiness",
  { timeout: 55_000 },
  async (failure, { signal }) => {
    const report = await performanceRun(signal, "prepare", {
      fetchResults: [failure, failure, failure],
    });
    expectReport(report, 1, { fetches: 3, checkouts: 0 });
    expect(report.fetches.every(({ args }) => args.includes("--depth=1"))).toBe(true);
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
    expect(report.githubOutput).toBe("ready=false\n");
    expect(report.githubSummary).toBe("");
  },
);

posixIt(
  "initial duplicate is verified before token or push",
  async ({ signal }) => {
    const report = await performanceRun(signal, "prepare", {
      performance: { mode: "prepare", duplicate: true },
    });
    expectReport(report, 0, { readyAttempts: 0, pushes: 0 });
    expect(report.githubOutput).toContain("already_published=true\n");
    expect(report.githubOutput).toContain("ready=true\n");
    expect(report.githubOutput).not.toContain("report_commit=");
    expect(report.githubSummary).toContain("### Clawgrit report already published");
    expect(report.commands.some(({ args }) => args[0] === "commit")).toBe(false);
    expect(
      report.commands.every(
        ({ envProbe, args }) =>
          !JSON.parse(envProbe!).token && JSON.parse(envProbe!).auth === (args[0] === "fetch"),
      ),
    ).toBe(true);
  },
  55_000,
);

posixIt.for([0, 1, 125])(
  "cached diff status %s commits only for ordinary 1",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await performanceRun(signal, "prepare", {
      gitFault: { match: "^diff --cached --quiet$", code, output: "" },
    });
    expect(report.code, report.output).toBe(code > 1 ? code : 0);
    expect(report.commands.filter(({ args }) => args[0] === "commit")).toHaveLength(
      code === 1 ? 1 : 0,
    );
    expect(report.githubOutput.includes("ready=true\n")).toBe(code <= 1);
  },
);

posixIt.for([125, "hang"] as const)(
  "ambiguous push %s reconciles only after extinction",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await performanceRun(signal, "publish", { pushResults: [code] });
    expectReport(report, 0, { pushes: 2, fetches: 1, checkouts: 1 });
    expect(report.output.match(/fixture backoff: \d+/gu)).toEqual(["fixture backoff: 2"]);
    expect(report.githubSummary).toContain("### Clawgrit report published");
    expect(report.performance?.config).not.toContain("AUTHORIZATION");
    for (const command of report.commands) {
      const scope = JSON.parse(command.envProbe!);
      expect(scope.token).toBe(false);
      const authenticated = [
        "push",
        "fetch",
        "ls-tree",
        "checkout",
        "cherry-pick",
        "rev-parse",
      ].includes(command.args[0]!);
      expect(scope.auth).toBe(authenticated);
      if (scope.auth) {
        expect(scope).toMatchObject({ count: "3", prompt: "0" });
      }
      if (command.args[0] === "push") {
        expect(command.configuration).toContain("core.hooksPath=/dev/null");
      }
    }
    expect(JSON.stringify(report)).not.toContain("fixture-performance-token");
    expect(JSON.stringify(report)).not.toContain(
      Buffer.from("x-access-token:fixture-performance-token").toString("base64"),
    );
  },
);

posixIt.for([false, true])(
  "five failed pushes always get five fetches (fetch fails=%s)",
  { timeout: 55_000 },
  async (fetchFails, { signal }) => {
    const report = await performanceRun(signal, "publish", {
      pushResults: [23, 23, 23, 23, 23],
      fetchResults: fetchFails ? [23, 23, 23, 23, 23] : [],
    });
    expectReport(report, 1, { pushes: 5, checkouts: fetchFails ? 0 : 4 });
    expect(report.boundaries.filter(({ name }) => name === "backoff")).toHaveLength(5);
    expect(report.fetches.map(({ args }) => args)).toEqual(
      Array.from({ length: 5 }, () => ["fetch", "--depth=1", "origin", "main"]),
    );
    expect(report.output.match(/fixture backoff: \d+/gu)).toEqual(
      [2, 4, 6, 8, 10].map((seconds) => `fixture backoff: ${seconds}`),
    );
    expect(report.commands.filter(({ args }) => args[0] === "cherry-pick")).toHaveLength(
      fetchFails ? 0 : 4,
    );
    expect(report.output.match(/::warning::Unable to refresh/gu) ?? []).toHaveLength(
      fetchFails ? 4 : 0,
    );
    expect(report.githubSummary).toContain("failed after 5 attempts.");
    expect(report.githubSummary).not.toContain("Published report:");
  },
);

posixIt.for([1, 5])(
  "remote duplicate after ambiguous attempt %s succeeds without replay",
  { timeout: 55_000 },
  async (attempt, { signal }) => {
    const report = await performanceRun(signal, "publish", {
      performance: { mode: "publish", remoteDuplicateAttempt: attempt },
      pushResults: Array.from({ length: attempt }, () => 124),
    });
    expectReport(report, 0, { pushes: attempt, fetches: attempt, checkouts: attempt - 1 });
    expect(report.githubSummary).toContain("### Clawgrit report published");
  },
);

posixIt.for([23, 125])(
  "ordinary cherry-pick and abort %s failures remain visible publish failure",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await performanceRun(signal, "publish", {
      pushResults: [23],
      gitFaults: [
        { match: "^cherry-pick -X ", code: 23 },
        { match: "^cherry-pick --abort$", code },
      ],
    });
    expectReport(report, 1, { pushes: 1 });
    expect(report.commands.at(-1)?.args).toEqual(["cherry-pick", "--abort"]);
    expect(report.output).toContain(
      "::error::Unable to replay the clawgrit report after a concurrent publish.",
    );
    expect(report.githubSummary).toBe("");
  },
);

posixIt.for(["owner", "python", "git"] as const)(
  "prepare setup failure %s cannot publish readiness",
  { timeout: 55_000 },
  async (setupFailure, { signal }) => {
    const report = await performanceRun(signal, "prepare", { setupFailure });
    expect(report.code, report.output).not.toBe(0);
    expect(report.pushes).toHaveLength(0);
    expect(report.githubOutput).not.toContain("ready=true");
  },
);

posixIt.for([125, "hang"] as const)(
  "reconciliation fetch %s warns once and retries without replay",
  { timeout: 55_000 },
  async (code, { signal }) => {
    const report = await performanceRun(signal, "publish", {
      pushResults: [23],
      fetchResults: [code],
    });
    expectReport(report, 0, { pushes: 2, fetches: 1, checkouts: 0 });
    expect(report.output.match(/::warning::Unable to refresh/gu)).toHaveLength(1);
  },
);

posixIt.for(["prepare", "publish"] as const)(
  "%s cancellation during real TERM-resistant cleanup prevents continuation",
  { timeout: 55_000 },
  async (mode, { signal }) => {
    const report = await performanceRun(signal, mode, {
      cancelDuringCleanup: true,
      cleanupCancelMatch: mode === "prepare" ? "^fetch " : "^push ",
      ...(mode === "prepare" ? { fetchResults: ["hang"] } : { pushResults: ["hang"] }),
    });
    expect(report.cancelledDuringCleanup).toBe(true);
    expect(report.code, report.output).toBe(143);
    expect(report.commands.at(-1)?.args[0]).toBe(mode === "prepare" ? "fetch" : "push");
    expect(report.githubOutput).not.toContain("ready=true");
    expect(report.githubSummary).toBe("");
    expect(report.output).not.toContain("fixture backoff:");
  },
);

posixIt(
  "cancellation during owned backoff prevents reconciliation fetch",
  async ({ signal }) => {
    const report = await performanceRun(signal, "publish", {
      pushResults: [23],
      realClock: true,
      cooperativeTrees: true,
      cancelDuringBackoff: true,
    });
    expectReport(report, 143, { pushes: 1, fetches: 0 });
    expect(report.githubSummary).toBe("");
    expect(report.boundaries.some(({ name }) => name === "backoff-cancel")).toBe(true);
  },
  55_000,
);

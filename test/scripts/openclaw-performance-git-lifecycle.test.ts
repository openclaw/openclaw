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
  },
);

posixIt(
  "baseline ordinary fetch failure is advisory after extinction",
  async ({ signal }) => {
    const report = await performanceRun(signal, "baseline", { fetchResults: [125, 125, 125] });
    expect(report.code, report.output).toBe(0);
    expect(report).toMatchObject({
      githubSummary: "No previous source performance baseline could be fetched.\n",
      githubEnv: "",
    });
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
  },
  55_000,
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
  ["prepare", "ls-tree", 125],
] as const)(
  "%s %s failure %s is terminal, never absence",
  { timeout: 55_000 },
  async ([mode, operation, code], { signal }) => {
    const report = await performanceRun(signal, mode, {
      gitFault: { match: `^${operation} `, code },
    });
    expect(report, report.output).toMatchObject({
      code,
      ...(mode === "baseline" ? { githubSummary: "", githubEnv: "" } : {}),
      ...(mode === "prepare" ? { githubOutput: "ready=false\n" } : {}),
    });
    expect(report.commands.at(-1)?.args[0]).toBe(operation);
  },
);

posixIt.for(["hang", 125] as const)(
  "prepare initial fetch %s cannot reach checkout, commit or token readiness",
  { timeout: 55_000 },
  async (failure, { signal }) => {
    const report = await performanceRun(signal, "prepare", {
      fetchResults: [failure, failure, failure],
    });
    expectReport(report, 1, { fetches: 3, checkouts: 0 });
    expect(report.fetches.every(({ args }) => args.includes("--depth=1"))).toBe(true);
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
    expect(report).toMatchObject({ githubOutput: "ready=false\n", githubSummary: "" });
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

posixIt(
  "prepare cancellation during real TERM-resistant cleanup prevents continuation",
  async ({ signal }) => {
    const report = await performanceRun(signal, "prepare", {
      cancelDuringCleanup: true,
      cleanupCancelMatch: "^fetch ",
      fetchResults: ["hang"],
    });
    expect(report.cancelledDuringCleanup).toBe(true);
    expect(report.code, report.output).toBe(143);
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
    expect(report.githubOutput).not.toContain("ready=true");
    expect(report.githubSummary).toBe("");
    expect(report.output).not.toContain("fixture backoff:");
  },
  55_000,
);

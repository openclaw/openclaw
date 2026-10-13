import type { SpawnSyncOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  collectFailures,
  formatCommand,
  formatFailures,
  parseArgs,
  parseTarget,
  rerunArgs,
  resolveRun,
} from "../../scripts/ci-failed-tests.mts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const run = {
  id: 100,
  run_attempt: 1,
  head_sha: "a".repeat(40),
  path: ".github/workflows/ci.yml",
  status: "completed",
  run_number: 10,
  html_url: "https://github.com/openclaw/openclaw/actions/runs/100",
};
const failure = (file: string, tests: string[] = [], classification = "new") => ({
  job: "checks-node",
  class: classification,
  files: [{ file, tests }],
  url: "job-url",
  failedSteps: [],
  reason: "Matching main job passed",
});
const file = "src/gateway/server.sessions.abort-authorization.test.ts";

describe("CI failed-test reruns", () => {
  it("opts --run into collecting ordinary failures outside CI", async () => {
    const invoked = Promise.withResolvers<{
      command: string;
      args: string[];
      options: SpawnSyncOptions;
    }>();
    const argv = process.argv;
    const exitCode = process.exitCode;
    const fixtureEnv = testRunnerFixtureEnv({ OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "0" });
    for (const key of ["CI", "GITHUB_ACTIONS", "OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE"]) {
      vi.stubEnv(key, fixtureEnv[key]);
    }
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      spawnSync: (command: string, args: string[], options: SpawnSyncOptions) => {
        invoked.resolve({ command, args, options });
        return { status: 1 };
      },
    }));
    vi.doMock("../../scripts/lib/plain-gh.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/plain-gh.mjs")>()),
      execGhReadAsync: async (args: string[]) => {
        const route = args[1]!;
        if (route.endsWith("/actions/runs/100")) {
          return JSON.stringify(run);
        }
        if (route.includes("/actions/runs/100/")) {
          return JSON.stringify({
            total_count: 1,
            jobs: [
              {
                id: 1,
                name: "checks-node",
                run_id: 100,
                run_attempt: 1,
                status: "completed",
                conclusion: "failure",
                html_url: "job-1",
              },
            ],
          });
        }
        if (route.includes("/actions/workflows/")) {
          return JSON.stringify({ workflow_runs: [] });
        }
        if (route.endsWith("/logs")) {
          return `FAIL gateway-server ${file} > native session > denies`;
        }
        throw new Error(`Unexpected route ${route}`);
      },
    }));
    try {
      process.argv = [
        process.execPath,
        fileURLToPath(new URL("../../scripts/ci-failed-tests.mts", import.meta.url)),
        run.html_url,
        "--run",
      ];
      await import("../../scripts/ci-failed-tests.mts");
      const child = await invoked.promise;
      expect(child.command).toBe("pnpm");
      expect(child.args).toEqual(["test", file, "--", "-t", "native session > denies"]);
      expect(child.options.env).toMatchObject({
        OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "1",
      });
      expect(child.options.env?.CI).toBeUndefined();
      expect(child.options.env?.GITHUB_ACTIONS).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      vi.unstubAllEnvs();
      vi.doUnmock("node:child_process");
      vi.doUnmock("../../scripts/lib/plain-gh.mjs");
      vi.resetModules();
    }
  });

  it("resolves PR head runs, skipping queued and older heads", async () => {
    const api = vi.fn(async (route: string) =>
      route.startsWith("/pulls/")
        ? { head: { sha: run.head_sha } }
        : {
            workflow_runs: [
              { ...run, id: 103, run_number: 13, status: "queued" },
              { ...run, id: 102, run_number: 12, head_sha: "b".repeat(40) },
              { ...run, id: 101, run_number: 11, status: "in_progress" },
              run,
            ],
          },
    );
    expect(await resolveRun("169647", "openclaw/openclaw", api)).toMatchObject({ id: 101 });
    expect(api.mock.calls[1]?.[0]).toContain(`head_sha=${run.head_sha}`);
  });

  it("resolves explicit run URLs and rejects other workflows/repositories", async () => {
    expect(parseTarget("38343026274", "openclaw/openclaw")).toEqual({
      kind: "run",
      id: 38343026274,
    });
    expect(
      parseTarget("https://github.com/openclaw/openclaw/pull/42", "openclaw/openclaw"),
    ).toEqual({ kind: "pr", id: 42 });
    expect(await resolveRun(run.html_url, "openclaw/openclaw", async () => run)).toEqual(run);
    await expect(
      resolveRun(run.html_url, "openclaw/openclaw", async () => ({ ...run, path: "other.yml" })),
    ).rejects.toThrow("not ci.yml");
    expect(() => parseTarget("https://github.com/other/repo/pull/42", "openclaw/openclaw")).toThrow(
      "differs",
    );
    expect(() => parseTarget("0", "openclaw/openclaw")).toThrow("Usage");
    expect(
      parseArgs(["42", "--repo=other/repo", "--json", "--run", "--include-pre-existing"]),
    ).toMatchObject({ repo: "other/repo", json: true, run: true, includePreExisting: true });
    expect(() => parseArgs(["42", "--bad"])).toThrow("Usage");
  });

  it("selects new/unknown files, deduplicates, and optionally includes inherited failures", () => {
    const failures = [
      failure(file, ["session > denies"], "unknown"),
      failure(file, ["session > denies"]),
      failure("test/old.test.ts", [], "pre-existing"),
    ];
    expect(formatCommand(rerunArgs(failures))).toBe(`pnpm test ${file} -- -t 'session > denies'`);
    expect(formatCommand(rerunArgs(failures, true))).toBe(`pnpm test ${file} test/old.test.ts`);
    expect(rerunArgs([failure(file, [], "pre-existing")])).toEqual([]);
  });

  it.each([
    [[], false],
    [["one", "two", "three", "four"], false],
    [['unsafe "$HOME"'], false],
    [["native s…"], false],
    [["a (literal)", "b.test"], true],
  ])("uses whole files unless short names are safe: %j", (names, filtered) => {
    const args = rerunArgs([failure(file, names)]);
    expect(args.includes("-t")).toBe(filtered);
    if (filtered) {
      expect(args.at(-1)).toBe("a \\(literal\\)|b\\.test");
    }
    expect(rerunArgs([failure(file, names), failure(file)])).toEqual(["test", file]);
  });

  it("quotes displayed patterns for zsh/bash without quoting execution arguments", () => {
    const args = rerunArgs([failure(file, ["session > denies!"])]);
    expect(args.at(-1)).toBe("session > denies!");
    expect(formatCommand(args)).toBe(`pnpm test ${file} -- -t 'session > denies!'`);
    expect(formatCommand(["test", file, "--", "-t", "owner's session!"])).toBe(
      `pnpm test ${file} -- -t 'owner'\\''s session!'`,
    );
  });

  it("starts failed-job log reads together and sorts results by job name", async () => {
    let releaseLogs!: (log: string) => void;
    const logs = new Promise<string>((resolve) => {
      releaseLogs = resolve;
    });
    let firstLogStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstLogStarted = resolve;
    });
    const requestedLogs: string[] = [];
    const jobs = ["zulu", "alpha", "bravo"].map((name, index) => ({
      id: index + 1,
      name,
      run_id: run.id,
      run_attempt: run.run_attempt,
      status: "completed",
      conclusion: "failure",
      html_url: `job-${index + 1}`,
    }));
    const api = async (route: string) => {
      if (route.startsWith("/actions/runs/100/")) {
        return { total_count: jobs.length, jobs };
      }
      if (route.startsWith("/actions/workflows/")) {
        return { workflow_runs: [] };
      }
      if (route.endsWith("/logs")) {
        requestedLogs.push(route);
        firstLogStarted();
        return logs;
      }
      throw new Error(`Unexpected route ${route}`);
    };
    const pending = collectFailures(run, "openclaw/openclaw", api);
    await started;
    const beforeRelease = [...requestedLogs];
    releaseLogs("build failed");
    const failures = await pending;
    expect(beforeRelease).toHaveLength(3);
    expect(failures.map((entry) => entry.job)).toEqual(["alpha", "bravo", "zulu"]);
  });

  it("shares classifier evidence, excludes control jobs, and explains non-Vitest failures", async () => {
    const job = (id: number, name: string, conclusion = "failure") => ({
      id,
      name,
      run_id: 100,
      run_attempt: 1,
      status: "completed",
      conclusion,
      html_url: `job-${id}`,
      steps:
        name === "check-docs"
          ? [
              { name: "Check docs", conclusion },
              { name: "Upload report", conclusion: "failure" },
            ]
          : [
              {
                name: name === "custom-e2e" ? "Run browser E2E" : "Run Node test shard",
                conclusion,
              },
            ],
    });
    const jobs = [
      job(1, "checks-node-new"),
      job(2, "check-docs"),
      job(3, "custom-e2e", "timed_out"),
      job(4, "pr-failure-report"),
      job(5, "openclaw/ci-gate"),
      job(6, "checks-node-old"),
    ];
    const main = {
      ...run,
      id: 200,
      event: "schedule",
      head_branch: "main",
      repository: { full_name: "openclaw/openclaw" },
      head_repository: { full_name: "openclaw/openclaw" },
    };
    const api = vi.fn(async (route: string) => {
      if (route.startsWith("/actions/workflows/")) {
        return { workflow_runs: [main] };
      }
      if (route.startsWith("/actions/runs/100/")) {
        return { total_count: jobs.length, jobs };
      }
      if (route.startsWith("/actions/runs/200/")) {
        return {
          total_count: 3,
          jobs: [
            job(10, "checks-node-new", "success"),
            job(20, "check-docs"),
            job(30, "checks-node-old", "success"),
          ].map((entry) => Object.assign(entry, { run_id: 200 })),
        };
      }
      if (route.endsWith("/logs")) {
        return route.includes("/1/") || route.includes("/6/")
          ? `2026-10-12T08:00:00Z [shard:gateway]  FAIL gateway-server (gateway-server-parallel) ${file} > native session > denies`
          : "build failed";
      }
      throw new Error(`Unexpected route ${route}`);
    });
    const failures = await collectFailures(run, "openclaw/openclaw", api);
    expect(failures.map((entry) => [entry.job, entry.class])).toEqual([
      ["checks-node-new", "new"],
      ["checks-node-old", "new"],
      ["custom-e2e", "unknown"],
      ["check-docs", "pre-existing"],
    ]);
    expect(failures[0]?.files).toEqual([{ file, tests: ["native session > denies"] }]);
    expect(api.mock.calls.filter(([route]) => route === "/actions/jobs/1/logs")).toHaveLength(1);
    const output = formatFailures(run, failures, formatCommand(rerunArgs(failures)));
    expect(output).toContain("no Vitest rerun; read log job-3");
    expect(output).toContain("failed step: Run browser E2E");
    expect(output).toContain("failed step: Check docs");
    expect(output).toContain("failed step: Upload report");
    expect(failures.find((entry) => entry.job === "check-docs")).toEqual({
      job: "check-docs",
      class: "pre-existing",
      files: [],
      url: "job-2",
      failedSteps: ["Check docs", "Upload report"],
      reason: expect.any(String),
    });
    expect(output).toContain("Pre-existing failures");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  collectFailures,
  formatCommand,
  formatFailures,
  localCheckCommand,
  parseArgs,
  parseTarget,
  rerunArgs,
  resolveRun,
} from "../../scripts/ci-failed-tests.mts";

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
  localCommand: null,
  reason: "Matching main job passed",
});
const file = "src/gateway/server.sessions.abort-authorization.test.ts";

describe("CI failed-test reruns", () => {
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
    expect(formatCommand(rerunArgs(failures))).toBe(`pnpm test ${file} -- -t "session > denies"`);
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

  it("maps failed check steps without mistaking setup failures for check failures", () => {
    const job = {
      id: 1,
      name: "check-lint-core-1",
      conclusion: "failure",
      html_url: "job-url",
      steps: [{ name: "Run hosted core lint stripe", conclusion: "failure" }],
    };
    expect(localCheckCommand(job)).toContain("--only=core");
    expect(
      localCheckCommand({
        ...job,
        steps: [{ name: "Setup Node environment", conclusion: "failure" }],
      }),
    ).toBeNull();
    expect(
      localCheckCommand({
        ...job,
        name: "check-prod-types",
        steps: [{ name: "Run check shard", conclusion: "failure" }],
      }),
    ).toBe("pnpm tsgo:prod");
    expect(
      localCheckCommand({
        ...job,
        steps: [{ name: "Check config docs baseline", conclusion: "failure" }],
      }),
    ).toBe("pnpm config:docs:check");
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
      steps: [{ name: name === "check-docs" ? "Check docs" : "Run Node test shard", conclusion }],
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
    expect(output).toContain("no local rerun: read log job-3");
    expect(output).toContain("pnpm check:docs");
    expect(output).toContain("Pre-existing failures");
  });
});

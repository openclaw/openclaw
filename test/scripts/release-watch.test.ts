import { describe, expect, it, vi } from "vitest";
import { watchPublication } from "../../scripts/lib/release-publication-watch.mts";
import { runReleaseWatch } from "../../scripts/release-watch.mts";

const repo = "openclaw/openclaw";
const tag = "v2026.11.5-beta.1";
const tooling = { head_branch: "release-publish/bbbbbbbbbbbb-7", head_sha: "b".repeat(40) };
const at = (minute: number) => `2026-11-04T03:${String(minute).padStart(2, "0")}:00Z`;
const run = (id: number, file: string, title: string, fields: object = {}) => ({
  id,
  run_attempt: 1,
  path: `.github/workflows/${file}`,
  event: "workflow_dispatch",
  actor: { login: "github-actions[bot]" },
  display_title: title,
  status: "completed",
  conclusion: "success",
  created_at: at(5),
  html_url: `https://github.com/${repo}/actions/runs/${id}`,
  ...tooling,
  ...fields,
});
const parentTitle = (file: string, parent = "900/2") => `${file} [${tag}] publish parent=${parent}`;
// The failed parent mirrors 2026.11.5-beta.1: a later resume parent shares its
// tooling tag and source, and the core child's Windows notify job failed.
const parent = run(900, "openclaw-release-publish.yml", "OpenClaw Release Publish", {
  run_attempt: 2,
  actor: { login: "release-manager" },
  repository: { full_name: repo },
  conclusion: "failure",
  created_at: at(0),
  updated_at: at(30),
});
const runs = [
  run(901, "plugin-npm-release.yml", `Plugin NPM Release [default] ${"c".repeat(40)}`),
  run(950, "plugin-npm-release.yml", `Plugin NPM Release [default] ${"c".repeat(40)}`, {
    created_at: at(45),
  }),
  run(951, "plugin-npm-release.yml", `Plugin NPM Artifact Preflight [default] ${"c".repeat(40)}`),
  run(902, "plugin-clawhub-release.yml", parentTitle("plugin-clawhub-release.yml")),
  run(952, "plugin-clawhub-release.yml", parentTitle("plugin-clawhub-release.yml", "900/1")),
  run(903, "plugin-clawhub-new.yml", parentTitle("plugin-clawhub-new.yml"), {
    head_branch: "main",
    head_sha: "d".repeat(40),
    status: "waiting",
    conclusion: null,
  }),
  run(904, "openclaw-npm-release.yml", parentTitle("openclaw-npm-release.yml")),
  run(953, "openclaw-npm-release.yml", parentTitle("openclaw-npm-release.yml"), {
    head_sha: "e".repeat(40),
  }),
];
const job = (id: number, name: string, conclusion: string) => ({
  id,
  name,
  status: "completed",
  conclusion,
  html_url: `job-${id}`,
});
const jobs: Record<string, object[]> = {
  904: [
    job(1, "publish_openclaw_npm", "success"),
    job(2, "Notify Windows of published Gateway packages", "failure"),
  ],
};

function respond(endpoint: string): unknown {
  const [, file] = /\/workflows\/([^/]+)\/runs\?/u.exec(endpoint) ?? [];
  if (file) {
    return { workflow_runs: runs.filter((entry) => entry.path.endsWith(`/${file}`)) };
  }
  const id = /\/runs\/(\d+)/u.exec(endpoint)?.[1] ?? "";
  if (endpoint.endsWith("/pending_deployments")) {
    return id === "903"
      ? [
          {
            environment: { id: 7, name: "clawhub-plugin-bootstrap" },
            current_user_can_approve: true,
          },
        ]
      : [];
  }
  if (endpoint.includes("/jobs?")) {
    const list = jobs[id] ?? [];
    return { total_count: list.length, jobs: list };
  }
  return [parent, ...runs].find((entry) => String(entry.id) === id);
}

describe("release:watch", () => {
  it("discovers the parent's own children and reports child gates and failed jobs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = vi.fn(async (_bin: string, args: string[]) => ({
      stdout: JSON.stringify(respond(args[1] ?? "")),
      stderr: "",
      exitCode: 0,
    }));
    const options = {
      run: "900",
      repo,
      once: true,
      json: true,
      pollSeconds: 1,
      timeoutSeconds: 60,
    };
    await expect(runReleaseWatch(options, runner)).resolves.toBe(1);
    const snapshot = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(snapshot.children.map((child: { id: string }) => child.id)).toEqual([
      "901",
      "902",
      "903",
      "904",
    ]);
    expect(snapshot).toMatchObject({
      state: "attention",
      pendingApprovals: [{ runId: "903", environment: "clawhub-plugin-bootstrap" }],
      failedRuns: [{ id: "900", conclusion: "failure" }],
      failedJobs: [{ runId: "904", name: "Notify Windows of published Gateway packages" }],
    });
    expect(runner.mock.calls.every(([bin, args]) => bin === "gh" && args.length === 2)).toBe(true);
  });

  it.each([
    "only-skipped-publication",
    "only-verified-core",
    "wrong-publication-conclusion",
    "wrong-core-conclusion",
    "foreign-attempt",
    "wrong-source",
    "wrong-tooling",
  ])("rejects insufficient publication evidence: %s", async (mode) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const plugin = run(
      901,
      "plugin-npm-release.yml",
      `Plugin NPM Release [extended-stable] ${"c".repeat(40)}`,
      mode === "wrong-tooling" ? { head_sha: "d".repeat(40) } : {},
    );
    const indicators = [
      job(10, "Publish plugins, then OpenClaw", "skipped"),
      job(11, "Verify already-published core npm package", "success"),
    ] as const;
    const runner = vi.fn(async (_bin: string, args: string[]) => {
      const endpoint = args[1] ?? "";
      let value: unknown;
      if (endpoint.includes("/workflows/")) {
        value = {
          workflow_runs:
            ["wrong-source", "wrong-tooling"].includes(mode) &&
            endpoint.includes("/plugin-npm-release.yml/")
              ? [plugin]
              : [],
        };
      } else if (endpoint.endsWith("/pending_deployments")) {
        value = [];
      } else if (endpoint.includes("/jobs?")) {
        let list: (typeof indicators)[number][] = [];
        if (mode === "only-skipped-publication") {
          list = [indicators[0]];
        }
        if (mode === "only-verified-core") {
          list = [indicators[1]];
        }
        if (mode === "wrong-publication-conclusion") {
          list = [{ ...indicators[0], conclusion: "success" }, indicators[1]];
        }
        if (mode === "wrong-core-conclusion") {
          list = [indicators[0], { ...indicators[1], conclusion: "skipped" }];
        }
        if (mode === "foreign-attempt" && endpoint.includes("/attempts/1/")) {
          list = [...indicators];
        }
        value = { total_count: list.length, jobs: list };
      } else {
        value = endpoint.endsWith("/901") ? plugin : { ...parent, conclusion: "success" };
      }
      return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
    });
    await expect(
      watchPublication(
        runner,
        {
          repo,
          parentRunId: "900",
          label: "test",
          rerunCommand: "test",
          releaseSha: mode === "wrong-source" ? "d".repeat(40) : "c".repeat(40),
        },
        { once: true, json: true, pollSeconds: 1, timeoutSeconds: 60 },
      ),
    ).rejects.toThrow("no observable plugin npm child");
    expect(
      runner.mock.calls
        .filter(([, args]) => args[1]?.includes("/jobs?"))
        .every(([, args]) => args[1]?.includes("/900/attempts/2/")),
    ).toBe(true);
  });

  it.each(["extended-stable", "docker-only", "missing-plugin"])(
    "observes %s publication without assuming the default plugin route",
    async (mode) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const plugin = run(
        901,
        "plugin-npm-release.yml",
        `Plugin NPM Release [extended-stable] ${"c".repeat(40)}`,
      );
      const runner = vi.fn(async (_bin: string, args: string[]) => {
        const endpoint = args[1] ?? "";
        let value: unknown;
        if (endpoint.includes("/workflows/")) {
          value = {
            workflow_runs:
              mode === "extended-stable" && endpoint.includes("/plugin-npm-release.yml/")
                ? [plugin]
                : [],
          };
        } else if (endpoint.endsWith("/pending_deployments")) {
          value = [];
        } else if (endpoint.includes("/jobs?")) {
          const list =
            mode === "docker-only"
              ? [
                  job(10, "Publish plugins, then OpenClaw", "skipped"),
                  job(11, "Verify already-published core npm package", "success"),
                ]
              : [];
          value = { total_count: list.length, jobs: list };
        } else {
          value = endpoint.endsWith("/901") ? plugin : { ...parent, conclusion: "success" };
        }
        return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
      });
      const observation = runReleaseWatch(
        { run: "900", repo, once: true, json: true, pollSeconds: 1, timeoutSeconds: 60 },
        runner,
      );
      if (mode === "missing-plugin") {
        await expect(observation).rejects.toThrow("no observable plugin npm child");
      } else {
        await expect(observation).resolves.toBe(0);
        const snapshot = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
        expect(snapshot.state).toBe("success");
        expect(snapshot.children.map((child: { id: string }) => child.id)).toEqual(
          mode === "extended-stable" ? ["901"] : [],
        );
      }
      expect(runner.mock.calls.every(([bin, args]) => bin === "gh" && args.length === 2)).toBe(
        true,
      );
    },
  );
});

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeReleaseGitHubState,
  observeReleaseNpmState,
  readReleasePublicationPackages,
} from "../../scripts/lib/release-publish-state.mts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv, writeJsonFile } from "../helpers/temp-repo.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.5";
const sourceSha = "a".repeat(40);
afterEach(() => vi.unstubAllGlobals());

describe("release publication state", () => {
  it.each([
    { latest: "2026.9.4", beta: version },
    { latest: version, beta: "2026.9.4" },
  ])("reports published plugin selector repair before dispatch: %j", async (tags) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          name: "@openclaw/example",
          versions: { [version]: { name: "@openclaw/example", version } },
          "dist-tags": tags,
        }),
      ),
    );
    const result = await observeReleaseNpmState({
      version,
      npmDistTag: "latest",
      publishOpenclawNpm: false,
      plugins: [
        {
          extensionId: "example",
          packageDir: "extensions/example",
          packageName: "@openclaw/example",
          version,
          channel: "stable",
          publishTag: "latest",
        },
      ],
    });
    expect(result.gates).toContainEqual(
      expect.objectContaining({
        id: "npm.package.@openclaw/example",
        status: "FAIL",
        remediation: expect.stringContaining("dist-tag"),
      }),
    );
  });

  it.each([
    {
      published: true,
      status: "WARN",
      message: "already published; dist-tag latest stays at 2026.9.7 (superseded)",
    },
    { published: false, status: "FAIL", message: 'cannot be safely moved to "2026.9.5" (ahead)' },
  ])(
    "gates a plugin behind an ahead latest selector: %j",
    async ({ published, status, message }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            name: "@openclaw/example",
            versions: {
              "2026.9.7": { name: "@openclaw/example", version: "2026.9.7" },
              ...(published ? { [version]: { name: "@openclaw/example", version } } : {}),
            },
            "dist-tags": { latest: "2026.9.7", beta: "2026.9.7" },
          }),
        ),
      );
      const result = await observeReleaseNpmState({
        version,
        npmDistTag: "latest",
        publishOpenclawNpm: false,
        plugins: [
          {
            extensionId: "example",
            packageDir: "extensions/example",
            packageName: "@openclaw/example",
            version,
            channel: "stable",
            publishTag: "latest",
          },
        ],
      });
      expect(result.gates).toContainEqual(
        expect.objectContaining({
          id: "npm.package.@openclaw/example",
          status,
          message: expect.stringContaining(message),
        }),
      );
      expect(result.publishedPackages.length).toBe(published ? 1 : 0);
    },
  );

  it.each(["plan", "already-published", "superseded"] as const)(
    "consumes the sealed %s decision without repeating registry planning",
    async (decision) => {
      const fetch = vi.fn(() => {
        throw new Error("unexpected registry read");
      });
      vi.stubGlobal("fetch", fetch);
      const result = await observeReleaseNpmState({
        version,
        npmDistTag: "latest",
        plugins: [],
        npmDecisions: [
          {
            packageName: "openclaw",
            packageVersion: version,
            plan: { channel: "stable", publishTag: "latest", mirrorDistTags: ["beta"] },
            decision,
            route: decision === "plan" ? null : "npm-readback",
            supersededBy: decision === "superseded" ? "2026.9.7" : null,
            bootstrap: false,
          },
        ],
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(result.corePublished).toBe(decision !== "plan");
      expect(result.gates.some((gate) => gate.status === "FAIL")).toBe(false);
      expect(result.gates.find((gate) => gate.id === "npm.package.openclaw")?.message).toContain(
        decision === "plan"
          ? "publication planned"
          : decision === "superseded"
            ? "superseded"
            : "already published",
      );
    },
  );

  it("reads plugin and opted-in core packages from the exact source commit, ignoring checkout changes", () => {
    const rootDir = temps.make("release-publish-state-");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: rootDir, env: createNestedGitEnv(), encoding: "utf8" },
      ).trim();
    git("init", "--quiet");
    writeJsonFile(join(rootDir, "package.json"), {
      name: "openclaw",
      version,
      dependencies: { "@openclaw/ai": version },
    });
    writePublishablePluginFixture(rootDir, { version, publishTo: "both" });
    writeJsonFile(join(rootDir, "packages/ai/package.json"), { name: "@openclaw/ai", version });
    writeJsonFile(join(rootDir, "packages/gateway-protocol/package.json"), {
      name: "@openclaw/gateway-protocol",
      version,
      openclaw: { release: { publishToNpm: true } },
    });
    writeJsonFile(join(rootDir, "packages/gateway-client/package.json"), {
      name: "@openclaw/gateway-client",
      version,
      openclaw: { release: { publishToNpm: false } },
    });
    git("add", ".");
    git("commit", "--quiet", "-m", "test: frozen release fixture");
    const sha = git("rev-parse", "HEAD");
    writeJsonFile(join(rootDir, "package.json"), { name: "openclaw", version: "2026.9.6" });
    writePublishablePluginFixture(rootDir, { version: "2026.9.6", publishTo: "both" });
    writeJsonFile(join(rootDir, "packages/ai/package.json"), {
      name: "@openclaw/ai",
      version: "2026.9.6",
    });

    const result = readReleasePublicationPackages({
      rootDir,
      sourceSha: sha,
      npmDistTag: "latest",
      pluginPublishScope: "all-publishable",
    });
    expect(result.version).toBe(version);
    expect(result.npmPlugins).toMatchObject([{ packageName: "@openclaw/demo-plugin", version }]);
    expect(result.clawhubPlugins).toMatchObject([
      { packageName: "@openclaw/demo-plugin", version },
    ]);
    expect(result.corePackages).toEqual([
      { packageName: "@openclaw/ai", version },
      { packageName: "@openclaw/gateway-protocol", version },
    ]);
    expect(() =>
      readReleasePublicationPackages({
        rootDir,
        sourceSha,
        npmDistTag: "latest",
        pluginPublishScope: "all-publishable",
      }),
    ).toThrow(`git fetch --no-tags origin ${sourceSha}`);
  });

  it.each(["beta", "latest"])(
    "observes core subpackages alongside the root on the %s route",
    async (npmDistTag) => {
      const requested: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const name = decodeURIComponent(new URL(input).pathname.slice(1));
          requested.push(name);
          return new Response(
            JSON.stringify({
              name,
              versions: { [version]: { name, version } },
              "dist-tags": { latest: version, beta: version },
            }),
          );
        }),
      );
      const corePackages = [
        { packageName: "@openclaw/ai", version },
        { packageName: "@openclaw/gateway-protocol", version },
      ];
      const result = await observeReleaseNpmState({
        version,
        npmDistTag,
        plugins: [],
        corePackages,
      });
      expect(requested.toSorted()).toEqual([
        "@openclaw/ai",
        "@openclaw/gateway-protocol",
        "openclaw",
      ]);
      expect(result.corePublished).toBe(true);
      expect(result.publishedPackages).toEqual([
        { packageName: "openclaw", version },
        ...corePackages,
      ]);
      expect(result.gates.some((gate) => gate.status === "FAIL")).toBe(false);
    },
  );
});

function observeRuns(params: {
  workflow: string;
  title?: string;
  log?: string;
  count?: number;
  onProgress?: (message: string) => void;
}) {
  return observeReleaseGitHubState({
    repository: "openclaw/openclaw",
    releaseTag: `v${version}`,
    sourceSha,
    npmDistTag: "latest",
    onProgress: params.onProgress,
    runGh: (args) => {
      const endpoint = args[1];
      if (endpoint === undefined) {
        throw new Error("Expected a GitHub REST endpoint.");
      }
      if (endpoint.includes("/releases/tags/")) {
        throw new Error("HTTP 404: Not Found");
      }
      if (endpoint.includes("/releases?")) {
        return "[]";
      }
      if (endpoint === "repos/openclaw/openclaw") {
        return JSON.stringify({ permissions: { push: true } });
      }
      if (endpoint.includes("/actions/workflows/")) {
        const selected =
          endpoint.includes(`/${params.workflow}/`) && endpoint.includes("status=waiting");
        return JSON.stringify({
          total_count: selected ? (params.count ?? 1) : 0,
          workflow_runs: selected
            ? [
                {
                  id: 123,
                  run_attempt: 2,
                  status: "waiting",
                  event: "workflow_dispatch",
                  display_title: params.title ?? "Plugin ClawHub Release",
                  html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
                },
              ]
            : [],
        });
      }
      if (endpoint.endsWith("/attempts/2/jobs?per_page=100")) {
        return JSON.stringify({ jobs: [{ id: 456, status: "completed" }] });
      }
      if (endpoint.endsWith("/jobs/456/logs") && params.log !== undefined) {
        return params.log;
      }
      if (endpoint.endsWith("/runs/789")) {
        return JSON.stringify({ status: "completed", conclusion: "failure" });
      }
      throw new Error(`Unavailable fixture endpoint: ${endpoint}`);
    },
  }).gates.filter((gate) => gate.id.startsWith(`concurrency.${params.workflow}.`));
}

describe("release concurrency observations", () => {
  it("bounds slow GitHub reads and names every uninspected inventory with its exact command", () => {
    let now = 0;
    const runGh = vi.fn((args: string[], options?: { timeoutMs?: number }) => {
      if (args[1]?.includes("/releases/tags/")) {
        throw new Error("HTTP 404: Not Found");
      }
      expect(options?.timeoutMs).toBe(100);
      now += 100;
      return "[]";
    });
    const result = observeReleaseGitHubState({
      repository: "openclaw/openclaw",
      releaseTag: `v${version}`,
      sourceSha,
      npmDistTag: "latest",
      budgetMs: 100,
      now: () => now,
      runGh,
    });
    expect(result.gates.every((gate) => gate.status === "WARN")).toBe(true);
    expect(result.gates[0]?.message).toContain("observation budget exhausted (100 ms)");
    for (const workflow of [
      "openclaw-release-publish.yml",
      "plugin-npm-release.yml",
      "plugin-clawhub-release.yml",
      "plugin-clawhub-new.yml",
    ]) {
      expect(result.gates).toContainEqual(
        expect.objectContaining({
          id: `concurrency.${workflow}.inventory`,
          status: "WARN",
          message: expect.stringContaining("observation budget exhausted"),
          remediation: expect.stringContaining(
            `gh api 'repos/openclaw/openclaw/actions/workflows/${workflow}/runs?status=in_progress&per_page=100' --method GET`,
          ),
        }),
      );
    }
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it("retains a gh stderr failure and exact unread command without hiding known blockers", () => {
    const result = observeReleaseGitHubState({
      repository: "openclaw/openclaw",
      releaseTag: `v${version}`,
      sourceSha,
      npmDistTag: "latest",
      runGh(args) {
        if (args[1]?.includes("/plugin-npm-release.yml/") && args[1].includes("status=queued")) {
          return JSON.stringify({
            total_count: 1,
            workflow_runs: [
              {
                id: 321,
                run_attempt: 1,
                status: "queued",
                event: "workflow_dispatch",
                display_title: `Plugin NPM Release [default] ${sourceSha}`,
                html_url: "https://github.com/openclaw/openclaw/actions/runs/321",
              },
            ],
          });
        }
        throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
          stderr: Buffer.from("HTTP 503: upstream unavailable"),
        });
      },
    });
    expect(result.gates).toContainEqual(
      expect.objectContaining({
        id: "concurrency.plugin-npm-release.yml.321",
        status: "FAIL",
      }),
    );
    expect(result.gates).toContainEqual(
      expect.objectContaining({
        id: "concurrency.plugin-npm-release.yml.inventory",
        status: "WARN",
        message: expect.stringContaining("HTTP 503: upstream unavailable"),
        remediation: expect.stringContaining("status=in_progress"),
      }),
    );
  });

  it("reads a published release by exact tag without transferring the full release inventory", () => {
    const release = {
      id: 7,
      draft: false,
      prerelease: false,
      tag_name: `v${version}`,
      html_url: `https://github.com/openclaw/openclaw/releases/tag/v${version}`,
      target_commitish: sourceSha,
    };
    const runGh = vi.fn((args: string[]) =>
      args[1]?.includes("/releases/tags/")
        ? JSON.stringify(release)
        : JSON.stringify({ total_count: 0, workflow_runs: [] }),
    );
    const result = observeReleaseGitHubState({
      repository: "openclaw/openclaw",
      releaseTag: `v${version}`,
      sourceSha,
      npmDistTag: "latest",
      runGh,
    });
    expect(result.release).toMatchObject(release);
    expect(runGh.mock.calls.some(([args]) => args[1]?.includes("/releases?"))).toBe(false);
  });

  it("replays a failed filtered release-inventory read with its exact --jq filter", () => {
    const result = observeReleaseGitHubState({
      repository: "openclaw/openclaw",
      releaseTag: `v${version}`,
      sourceSha,
      npmDistTag: "latest",
      runGh(args) {
        if (args[1]?.includes("/releases/tags/")) {
          throw new Error("HTTP 404: Not Found");
        }
        if (args[1]?.includes("/releases?")) {
          throw new Error("HTTP 502: Bad Gateway");
        }
        return JSON.stringify({ total_count: 0, workflow_runs: [] });
      },
    });
    const gate = result.gates.find((entry) => entry.id === "github.release");
    expect(gate).toMatchObject({ status: "WARN", message: expect.stringContaining("HTTP 502") });
    expect(gate?.remediation).toContain(
      `gh api 'repos/openclaw/openclaw/releases?per_page=100&page=1' --method GET --jq 'map(if .tag_name == "v${version}" then . else {tag_name} end)'`,
    );
  });

  it("recognizes the npm target from the exact preflight title because it shares the publish group", () => {
    const gates = observeRuns({
      workflow: "plugin-npm-release.yml",
      title: `Plugin NPM Artifact Preflight [default] ${sourceSha}`,
    });
    expect(gates).toMatchObject([
      { status: "FAIL", message: expect.stringContaining("exact workflow run title") },
    ]);
  });

  it("reports the exact waiting ClawHub target and its terminal parent without claiming cancellation is safe", () => {
    const log = [
      `2026-09-18T01:02:03Z   TARGET_REF: ${sourceSha}`,
      "2026-09-18T01:02:03Z   DRY_RUN: false",
      "2026-09-18T01:02:03Z   RELEASE_PUBLISH_RUN_ID: 789",
    ].join("\n");
    const progress: string[] = [];
    const gates = observeRuns({
      workflow: "plugin-clawhub-release.yml",
      log,
      onProgress: (message) => progress.push(message),
    });
    expect(progress.join("\n")).toContain("release lookup page 1");
    expect(progress.join("\n")).toContain("workflow plugin-clawhub-release.yml inventory");
    expect(progress.join("\n")).toContain("inspecting candidate run 123 1/1 via job log");
    expect(gates).toMatchObject([
      { status: "FAIL", message: expect.stringContaining("Parent 789 is terminal (failure)") },
    ]);
    expect(gates[0]?.remediation).toContain("checking parent ownership");
  });

  it.each([
    { title: "missing job log", log: undefined },
    { title: "missing dry-run input", log: `2026-09-18T01:02:03Z   TARGET_REF: ${sourceSha}` },
    {
      title: "conflicting input evidence",
      log: `2026-09-18T01:02:03Z   TARGET_REF: ${sourceSha}\n2026-09-18T01:02:04Z   TARGET_REF: ${"b".repeat(40)}\n2026-09-18T01:02:05Z   DRY_RUN: false`,
    },
  ])("keeps $title unresolved instead of declaring the group clear", ({ log }) => {
    expect(observeRuns({ workflow: "plugin-clawhub-release.yml", log })).toMatchObject([
      { status: "WARN" },
    ]);
  });

  it("does not confuse isolated ClawHub dry runs with target publication", () => {
    const log = `2026-09-18T01:02:03Z   TARGET_REF: ${sourceSha}\n2026-09-18T01:02:03Z   DRY_RUN: true`;
    expect(observeRuns({ workflow: "plugin-clawhub-release.yml", log })).toMatchObject([
      { status: "PASS" },
    ]);
  });

  it("keeps a truncated active-run inventory unresolved", () => {
    const gates = observeRuns({
      workflow: "plugin-npm-release.yml",
      title: `Plugin NPM Release [default] ${"b".repeat(40)}`,
      count: 101,
    });
    expect(gates).toMatchObject([
      { status: "WARN", message: expect.stringContaining("bounded first page") },
    ]);
  });
});

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

function observeRuns(params: { workflow: string; title?: string; log?: string; count?: number }) {
  return observeReleaseGitHubState({
    repository: "openclaw/openclaw",
    releaseTag: `v${version}`,
    sourceSha,
    npmDistTag: "latest",
    runGh: (args) => {
      const endpoint = args[1];
      if (endpoint === undefined) {
        throw new Error("Expected a GitHub REST endpoint.");
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
    const gates = observeRuns({ workflow: "plugin-clawhub-release.yml", log });
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

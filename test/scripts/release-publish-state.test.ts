import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeReleaseGitHubState,
  observeReleaseNpmState,
  readReleasePublicationPackages,
} from "../../scripts/lib/release-publish-state.mts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";
import { fixtureGit, expectGate } from "./release-publish.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.5";
const sourceSha = "a".repeat(40);
const pkg = (packageName: string) => ({ packageName, version });
const corePackages = [pkg("@openclaw/ai"), pkg("@openclaw/gateway-protocol")];
const npmOptions = { version, npmDistTag: "latest", plugins: [] };
const distTags = (latest: string, beta = latest) => ({ latest, beta });
function registry(name: string, versions = [version], tags = distTags(version)) {
  return Response.json({
    name,
    versions: Object.fromEntries(versions.map((entry) => [entry, { name, version: entry }])),
    "dist-tags": tags,
  });
}
const githubOptions = {
  repository: "openclaw/openclaw",
  releaseTag: `v${version}`,
  sourceSha,
  npmDistTag: "latest",
};
function observeGitHub(
  runGh: NonNullable<Parameters<typeof observeReleaseGitHubState>[0]["runGh"]>,
  options: Partial<Parameters<typeof observeReleaseGitHubState>[0]> = {},
) {
  return observeReleaseGitHubState({ ...githubOptions, ...options, runGh });
}
function workflowRun(id: number, status: string, display_title: string, run_attempt = 1) {
  return {
    id,
    status,
    display_title,
    run_attempt,
    event: "workflow_dispatch",
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${id}`,
  };
}
const runInventory = (
  workflow_runs: ReturnType<typeof workflowRun>[],
  total_count = workflow_runs.length,
) => JSON.stringify({ total_count, workflow_runs });
const pluginOptions = {
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
} satisfies Parameters<typeof observeReleaseNpmState>[0];
afterEach(() => vi.unstubAllGlobals());

describe("release publication state", () => {
  it.each<[string, string, string[], string | undefined, number | undefined]>([
    ["2026.9.4", version, [version], undefined, undefined],
    [
      "2026.9.7",
      "2026.9.7",
      ["2026.9.7", version],
      "already published; dist-tag latest stays at 2026.9.7 (superseded)",
      1,
    ],
    ["2026.9.7", "2026.9.7", ["2026.9.7"], 'cannot be safely moved to "2026.9.5" (ahead)', 0],
  ])(
    "gates plugin publication against existing registry selectors: $tags",
    async (latest, beta, versions, message, published) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => registry("@openclaw/example", versions, distTags(latest, beta))),
      );
      const result = await observeReleaseNpmState(pluginOptions);
      expectGate(result.gates, {
        id: "npm.package.@openclaw/example",
        status: published === 1 ? "WARN" : "FAIL",
        ...(message
          ? { message: expect.stringContaining(message) }
          : { remediation: expect.stringContaining("dist-tag") }),
      });
      if (published !== undefined) {
        expect(result.publishedPackages.length).toBe(published);
      }
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
        ...npmOptions,
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
    const git = fixtureGit(rootDir, "Fixture", "fixture@example.invalid", true);
    git("init", "--quiet");
    writeJsonFile(join(rootDir, "package.json"), {
      name: "openclaw",
      version,
      dependencies: { "@openclaw/ai": version },
    });
    writePublishablePluginFixture(rootDir, { version, publishTo: "both" });
    const writePackage = (name: string, packageVersion = version, publishToNpm?: boolean) =>
      writeJsonFile(join(rootDir, `packages/${name}/package.json`), {
        name: `@openclaw/${name}`,
        version: packageVersion,
        ...(publishToNpm === undefined ? {} : { openclaw: { release: { publishToNpm } } }),
      });
    writePackage("ai");
    writePackage("gateway-protocol", version, true);
    writePackage("gateway-client", version, false);
    git("add", ".");
    git("commit", "--quiet", "-m", "test: frozen release fixture");
    const sha = git("rev-parse", "HEAD");
    writeJsonFile(join(rootDir, "package.json"), { name: "openclaw", version: "2026.9.6" });
    writePublishablePluginFixture(rootDir, { version: "2026.9.6", publishTo: "both" });
    writePackage("ai", "2026.9.6");

    const readPackages = (commit: string) =>
      readReleasePublicationPackages({
        rootDir,
        sourceSha: commit,
        npmDistTag: "latest",
        pluginPublishScope: "all-publishable",
      });
    const packages = readPackages(sha);
    expect(packages.corePackages).toEqual(corePackages);
    expect(packages).toMatchObject({
      version,
      npmPlugins: [pkg("@openclaw/demo-plugin")],
      clawhubPlugins: [pkg("@openclaw/demo-plugin")],
    });
    expect(() => readPackages(sourceSha)).toThrow(`git fetch --no-tags origin ${sourceSha}`);
  });

  it("observes core subpackages alongside the root on the beta route", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const name = decodeURIComponent(new URL(input).pathname.slice(1));
        requested.push(name);
        return registry(name);
      }),
    );
    const result = await observeReleaseNpmState({
      ...npmOptions,
      npmDistTag: "beta",
      corePackages,
    });
    expect(requested.toSorted()).toEqual(
      ["openclaw", ...corePackages.map((entry) => entry.packageName)].toSorted(),
    );
    expect(result.corePublished).toBe(true);
    expect(result.publishedPackages).toEqual([pkg("openclaw"), ...corePackages]);
    expect(result.gates.some((gate) => gate.status === "FAIL")).toBe(false);
  });
});

function observeRuns(params: { workflow: string; title?: string; log?: string; count?: number }) {
  return observeGitHub((args) => {
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
      return runInventory(
        selected ? [workflowRun(123, "waiting", params.title ?? "Plugin ClawHub Release", 2)] : [],
        selected ? (params.count ?? 1) : 0,
      );
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
    const result = observeGitHub(runGh, { budgetMs: 100, now: () => now });
    expect(result.gates.every((gate) => gate.status === "WARN")).toBe(true);
    expect(result.gates[0]?.message).toContain("observation budget exhausted (100 ms)");
    expect(result.gates).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^concurrency\..*\.inventory$/),
        status: "WARN",
        message: expect.stringContaining("observation budget exhausted"),
        remediation: expect.stringContaining("gh api"),
      }),
    );
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it("retains a gh stderr failure and exact unread command without hiding known blockers", () => {
    const result = observeGitHub((args) => {
      if (args[1]?.includes("/plugin-npm-release.yml/") && args[1].includes("status=queued")) {
        return runInventory([
          workflowRun(321, "queued", `Plugin NPM Release [default] ${sourceSha}`),
        ]);
      }
      throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
        stderr: Buffer.from("HTTP 503: upstream unavailable"),
      });
    });
    expectGate(result.gates, {
      id: "concurrency.plugin-npm-release.yml.321",
      status: "FAIL",
    });
    expectGate(result.gates, {
      id: "concurrency.plugin-npm-release.yml.inventory",
      status: "WARN",
      message: expect.stringContaining("HTTP 503: upstream unavailable"),
      remediation: expect.stringContaining("status=in_progress"),
    });
  });

  it("reads a published release by exact tag without transferring the full release inventory", () => {
    const release = {
      id: 7,
      draft: false,
      prerelease: false,
      tag_name: `v${version}`,
      html_url: `https://github.com/openclaw/openclaw/releases/tag/v${version}`,
      target_commitish: sourceSha,
      body: "Published release notes",
      assets: [{ name: "dependency-evidence.zip" }],
    };
    const runGh = vi.fn((args: string[]) =>
      args[1]?.includes("/releases/tags/") ? JSON.stringify(release) : runInventory([]),
    );
    const result = observeGitHub(runGh);
    expect(result.release).toMatchObject(release);
    expect(runGh.mock.calls.some(([args]) => args[1]?.includes("/releases?"))).toBe(false);
  });

  const log = (...lines: string[]) =>
    [`TARGET_REF: ${sourceSha}`, ...lines]
      .map((line) => `2026-09-18T01:02:03Z   ${line}`)
      .join("\n");
  const npmRun = (title: string, count = 1) => ({
    workflow: "plugin-npm-release.yml",
    title,
    count,
  });
  const conflictingLog = `${log()}\n2026-09-18T01:02:04Z   TARGET_REF: ${"b".repeat(40)}\n2026-09-18T01:02:05Z   DRY_RUN: false`;
  it.each`
    evidence                        | status    | scenario                                                          | message
    ${"exact npm preflight title"}  | ${"FAIL"} | ${npmRun(`Plugin NPM Artifact Preflight [default] ${sourceSha}`)} | ${"exact workflow run title"}
    ${"terminal parent"}            | ${"FAIL"} | ${{ log: log("DRY_RUN: false", "RELEASE_PUBLISH_RUN_ID: 789") }}  | ${"Parent 789 is terminal (failure)"}
    ${"missing job log"}            | ${"WARN"} | ${{}}                                                             | ${undefined}
    ${"missing dry-run input"}      | ${"WARN"} | ${{ log: log() }}                                                 | ${undefined}
    ${"conflicting input evidence"} | ${"WARN"} | ${{ log: conflictingLog }}                                        | ${undefined}
    ${"isolated ClawHub dry run"}   | ${"PASS"} | ${{ log: log("DRY_RUN: true") }}                                  | ${undefined}
    ${"truncated active inventory"} | ${"WARN"} | ${npmRun(`Plugin NPM Release [default] ${"b".repeat(40)}`, 101)}  | ${"bounded first page"}
  `(
    "qualifies concurrency evidence: $evidence",
    ({
      evidence,
      status,
      scenario,
      message,
    }: {
      evidence: string;
      status: string;
      scenario: Partial<Parameters<typeof observeRuns>[0]>;
      message?: string;
    }) => {
      const gates = observeRuns({
        ...scenario,
        workflow: scenario.workflow ?? "plugin-clawhub-release.yml",
      });
      expect(gates).toMatchObject([
        { status, ...(message ? { message: expect.stringContaining(message) } : {}) },
      ]);
      if (evidence === "terminal parent") {
        expect(gates[0]?.remediation).toContain("checking parent ownership");
      }
    },
  );
});

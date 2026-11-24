import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { gh, pauseBuild } = vi.hoisted(() => ({ gh: vi.fn(), pauseBuild: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: gh }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: pauseBuild,
}));
const nativeProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

const core = "openclaw/openclaw";
const packaging = "openclaw/openclaw-windows-packaging";
const releases = "openclaw/releases";
const sha = "a".repeat(40);
const tooling = "b".repeat(40);
const packagingHead = "c".repeat(40);
const tag = "v2026.10.7";
const requestTitle = `Windows Gateway Release Request [${tag}] source=${sha}`;
const temps = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

type Dispatch = { endpoint: string; body: unknown };
type Fixture = {
  tag?: string;
  current?: Record<string, unknown>;
  release?: Record<string, unknown>;
  signedTag?: Record<string, unknown>;
  previous?: Record<string, unknown>[];
  source?: Record<string, unknown>;
  storeSource?: Record<string, unknown>;
  build?: Record<string, unknown>;
  artifacts?: { name: string; expired: boolean }[];
  largeHistory?: boolean;
  incompleteHistory?: boolean;
  expiredBundle?: boolean;
  ambiguousStore?: boolean;
  pendingBuild?: boolean;
  cancelDuringBuildWait?: boolean;
};

beforeEach(() => {
  vi.resetModules();
  gh.mockReset();
  pauseBuild.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(mode: "request" | "publish", fixture: Fixture = {}) {
  const releaseTag = fixture.tag ?? tag;
  const releaseVersion = releaseTag.slice(1);
  const releaseChannel = releaseTag.includes("-beta.") ? "beta" : "stable";
  const directory = temps.make("windows-gateway-release-");
  const evidence = join(directory, "evidence.json");
  const dispatches: Dispatch[] = [];
  const parentPath =
    mode === "request" ? "openclaw-release-publish.yml" : "windows-gateway-release.yml";
  let requestCancelled = false;
  let buildPending = fixture.pendingBuild || fixture.cancelDuringBuildWait || false;
  pauseBuild.mockImplementation(async () => {
    requestCancelled = fixture.cancelDuringBuildWait ?? false;
  });
  process.argv = [process.execPath, "scripts/windows-gateway-release.mjs", mode];
  process.exitCode = undefined;
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: core,
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: tooling,
    RELEASE_TAG: releaseTag,
    RELEASE_SHA: sha,
    WINDOWS_GATEWAY_RELEASE_EVIDENCE: evidence,
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
  })) {
    vi.stubEnv(name, value);
  }
  const source = {
    repository: `https://github.com/${core}`,
    requestedRef: sha,
    resolvedCommit: sha,
    packageVersion: releaseVersion,
    workflowRunId: "51",
    packagingCommit: packagingHead,
    workflowRef: `${packaging}/.github/workflows/gateway-msix.yml@refs/heads/main`,
    githubRef: "refs/heads/main",
    eventName: "workflow_dispatch",
    releaseChannel,
    signingMode: releaseChannel === "beta" ? "official" : "store",
    releaseIdentitySource: {
      repository: `https://github.com/${core}`,
      resolvedCommit: sha,
      packageVersion: releaseVersion,
      releaseTag,
      channel: releaseChannel,
    },
    ...fixture.source,
  };
  const storeSource = {
    runId: "51",
    runAttempt: 2,
    packagingCommit: packagingHead,
    releaseTag: `${releaseTag}-msix.1`,
    releaseChannel,
    bundleName: `OpenClawGateway-${releaseVersion}-msix.1-store.msixbundle`,
    bundleSha256: "e".repeat(64),
    ...fixture.storeSource,
  };
  gh.mockImplementation((binary: string, args: string[], options: { input?: string }) => {
    expect(binary).toBe("gh");
    if (args[0] === "run") {
      const destination = args[args.indexOf("--dir") + 1];
      if (!destination) {
        throw new Error("Missing download directory");
      }
      const name = args[args.indexOf("--name") + 1];
      if (name === "openclaw-source-resolution") {
        writeFileSync(join(destination, "source-resolution.json"), JSON.stringify(source));
      } else if (name === "store-release-source-2") {
        writeFileSync(join(destination, "store-source.json"), JSON.stringify(storeSource));
      } else {
        throw new Error(`Unexpected artifact download: ${name}`);
      }
      return "";
    }
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    if (!endpoint) {
      throw new Error("Missing GitHub endpoint");
    }
    if (options.input) {
      dispatches.push({ endpoint, body: JSON.parse(options.input) });
      const id = endpoint.includes("gateway-msix.yml")
        ? 51
        : endpoint.includes("windows-store-publish.yml")
          ? 61
          : 41;
      return JSON.stringify(fixture.ambiguousStore && id === 61 ? {} : { workflow_run_id: id });
    }
    let value: unknown;
    if (endpoint.endsWith("/actions/runs/10")) {
      value = {
        repository: { full_name: core },
        head_repository: { full_name: core },
        path: `.github/workflows/${parentPath}`,
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: tooling,
        status: requestCancelled ? "cancelled" : "in_progress",
        run_attempt: 1,
        run_number: 10,
        ...fixture.current,
      };
    } else if (endpoint.endsWith(`/releases/tags/${releaseTag}`)) {
      value = {
        tag_name: releaseTag,
        draft: false,
        prerelease: releaseTag.includes("-beta."),
        ...fixture.release,
      };
    } else if (endpoint.includes("/git/ref/tags/")) {
      value = { object: { type: "tag", sha: "d".repeat(40) } };
    } else if (endpoint.includes("/git/tags/")) {
      value = {
        tag: releaseTag,
        object: { type: "commit", sha },
        verification: { verified: true },
        ...fixture.signedTag,
      };
    } else if (endpoint.includes("windows-gateway-release.yml/runs")) {
      value = {
        items: fixture.previous ?? [],
        total_count: fixture.incompleteHistory ? 1 : (fixture.previous?.length ?? 0),
      };
      if (fixture.largeHistory) {
        // Exercise the real Node stdout cap with a fixed oversized API fixture.
        // gh's projection omits irrelevant commit metadata before it is buffered.
        const history = [
          {
            id: 1,
            display_title: "unrelated release",
            event: "workflow_dispatch",
            head_branch: "main",
          },
        ];
        const payload = args.includes("--jq")
          ? { items: history, total_count: 1 }
          : [
              {
                workflow_runs: [
                  {
                    ...history[0],
                    head_commit: { message: "x".repeat(1_100_000) },
                  },
                ],
                total_count: 1,
              },
            ];
        return nativeProcess.execFileSync(
          process.execPath,
          ["-e", "process.stdin.pipe(process.stdout)"],
          {
            input: JSON.stringify(payload),
            encoding: "utf8",
            env: {},
          },
        );
      }
    } else if (endpoint.endsWith("/git/ref/heads/main")) {
      value = { object: { sha: packagingHead } };
    } else if (endpoint.endsWith("/actions/runs/51")) {
      value = {
        repository: { full_name: packaging },
        head_repository: { full_name: packaging },
        path: ".github/workflows/gateway-msix.yml",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: packagingHead,
        run_attempt: 2,
        status: buildPending ? "in_progress" : "completed",
        conclusion: "success",
        ...fixture.build,
      };
      buildPending = false;
    } else if (endpoint.includes("/artifacts?")) {
      const artifacts = fixture.artifacts ?? [
        { name: "openclaw-source-resolution", expired: false },
        {
          name: "openclaw-gateway-msix-store-submission-2",
          expired: fixture.expiredBundle ?? false,
        },
        { name: "store-release-source-2", expired: false },
      ];
      value = { items: artifacts, total_count: artifacts.length };
    } else {
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
    return JSON.stringify(value);
  });
  await import("../../scripts/windows-gateway-release.mjs");
  return {
    dispatches,
    status: process.exitCode ?? 0,
    evidence: existsSync(evidence) ? JSON.parse(readFileSync(evidence, "utf8")) : undefined,
  };
}

describe("Gateway Store release handoff", () => {
  it.each(["openclaw-release-publish.yml", "openclaw-release-promote.yml"])(
    "detaches publication from %s",
    async (parent) => {
      const result = await run("request", { current: { path: `.github/workflows/${parent}` } });
      expect(result.status).toBe(0);
      expect(result.dispatches).toEqual([
        {
          endpoint: `repos/${core}/actions/workflows/windows-gateway-release.yml/dispatches`,
          body: { ref: "main", inputs: { tag, release_sha: sha } },
        },
      ]);
      expect(result.evidence).toMatchObject({ state: "requested", requestRunId: "41" });
    },
  );

  it.each(["success", "failure", null])(
    "reuses an existing request with conclusion %s instead of publishing twice",
    async (conclusion) => {
      const result = await run("request", {
        previous: [
          {
            id: 9,
            display_title: requestTitle,
            event: "workflow_dispatch",
            head_branch: "main",
            status: conclusion ? "completed" : "in_progress",
            conclusion,
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.dispatches).toEqual([]);
      expect(result.evidence).toMatchObject({ state: "existing-request", requestRunId: "9" });
    },
  );

  it("builds the exact payload and requests central approval for only that successful run", async () => {
    const result = await run("publish");
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([
      {
        endpoint: `repos/${packaging}/actions/workflows/gateway-msix.yml/dispatches`,
        body: {
          ref: "main",
          inputs: { openclaw_ref: sha, signing_mode: "store", publish_release: "false" },
        },
      },
      {
        endpoint: `repos/${releases}/actions/workflows/windows-store-publish.yml/dispatches`,
        body: {
          ref: "main",
          inputs: { product: "gateway", run_id: "51", channel: "production", automatic: "true" },
        },
      },
    ]);
    expect(result.evidence).toMatchObject({
      state: "store-approval-pending",
      buildRunId: "51",
      storeRunId: "61",
      storeRepository: releases,
      storeChannel: "production",
      storeSource: { runId: "51", runAttempt: 2, releaseChannel: "stable" },
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`https://github.com/${releases}/actions/runs/61`),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Release-manager approval and Microsoft acceptance remain pending"),
    );
  });

  it("does not buffer oversized irrelevant run metadata while checking replay history", async () => {
    const result = await run("request", { largeHistory: true });
    expect(result.status).toBe(0);
    expect(result.evidence).toMatchObject({ state: "requested", requestRunId: "41" });
  });

  it.each([
    { resolvedCommit: tooling },
    {
      releaseIdentitySource: {
        repository: `https://github.com/${core}`,
        resolvedCommit: tooling,
        packageVersion: "2026.10.8",
        releaseTag: "v2026.10.8",
        channel: "stable",
      },
    },
    { packagingCommit: tooling },
    { signingMode: "unsigned" },
  ])("does not submit a mismatched source snapshot: %j", async (source) => {
    const result = await run("publish", { source });
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Do not submit this build"));
  });

  it.each([
    { build: { conclusion: "failure" } },
    { build: { head_branch: "feature" } },
    { expiredBundle: true },
    { cancelDuringBuildWait: true },
  ])("keeps failed, foreign, expired, and revoked builds out of the Store: %j", async (fixture) => {
    const result = await run("publish", fixture);
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(1);
  });

  it.each([
    { current: { status: "cancelled" } },
    { current: { run_attempt: 2 } },
    {
      previous: [
        {
          id: 9,
          run_number: 9,
          display_title: requestTitle,
          event: "workflow_dispatch",
          head_branch: "main",
        },
      ],
    },
    { incompleteHistory: true },
    { release: { draft: true } },
    { signedTag: { object: { type: "commit", sha: tooling } } },
  ])("refuses unsafe or duplicate requests before any dispatch: %j", async (fixture) => {
    const result = await run("publish", fixture);
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
  });

  it.each([
    [tag, "production"],
    ["v2026.10.7-beta.2", "development"],
  ])(
    "retains an ambiguous %s Store dispatch without claiming delivery",
    async (releaseTag, target) => {
      const result = await run("publish", { tag: releaseTag, ambiguousStore: true });
      expect(result.status).toBe(1);
      expect(result.dispatches).toHaveLength(2);
      expect(result.evidence).toMatchObject({
        state: "store-dispatch-attempted",
        buildRunId: "51",
        storeChannel: target,
      });
      expect(result.evidence.storeRunId).toBeUndefined();
    },
  );
});

describe("Gateway beta MSIX handoff", () => {
  const betaTag = "v2026.10.7-beta.2";

  it.each(["openclaw-release-publish.yml", "openclaw-release-promote.yml"])(
    "requests the published beta from %s",
    async (parent) => {
      const result = await run("request", {
        tag: betaTag,
        current: { path: `.github/workflows/${parent}` },
      });
      expect(result.status).toBe(0);
      expect(result.dispatches).toEqual([
        {
          endpoint: `repos/${core}/actions/workflows/windows-gateway-release.yml/dispatches`,
          body: { ref: "main", inputs: { tag: betaTag, release_sha: sha } },
        },
      ]);
    },
  );

  it("waits for the exact official beta build and requests central Development approval", async () => {
    const result = await run("publish", { tag: betaTag, pendingBuild: true });
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([
      {
        endpoint: `repos/${packaging}/actions/workflows/gateway-msix.yml/dispatches`,
        body: {
          ref: "main",
          inputs: {
            release_channel: "beta",
            gateway_version: "2026.10.7-beta.2",
            openclaw_ref: sha,
            signing_mode: "official",
            publish_release: "true",
          },
        },
      },
      {
        endpoint: `repos/${releases}/actions/workflows/windows-store-publish.yml/dispatches`,
        body: {
          ref: "main",
          inputs: { product: "gateway", run_id: "51", channel: "development", automatic: "true" },
        },
      },
    ]);
    expect(result.evidence).toMatchObject({
      state: "store-approval-pending",
      buildRunId: "51",
      storeRunId: "61",
      storeChannel: "development",
      storeSource: { runId: "51", runAttempt: 2, releaseChannel: "beta" },
    });
  });

  it.each([
    { source: { releaseChannel: "stable" } },
    { source: { signingMode: "store" } },
    {
      source: {
        releaseIdentitySource: {
          repository: `https://github.com/${core}`,
          resolvedCommit: sha,
          packageVersion: "2026.10.7-beta.2",
          releaseTag: betaTag,
          channel: "stable",
        },
      },
    },
    { storeSource: { runId: "52" } },
    { storeSource: { runAttempt: 1 } },
    { storeSource: { packagingCommit: tooling } },
    { storeSource: { releaseChannel: "stable" } },
    { storeSource: { releaseTag: `${tag}-msix.1` } },
    { storeSource: { bundleName: "OpenClawGateway-2026.10.7-msix.1-store.msixbundle" } },
    { storeSource: { bundleSha256: "not-a-sha256" } },
    { build: { conclusion: "failure" } },
    { cancelDuringBuildWait: true },
  ])("does not route unverified or revoked beta artifacts to Development: %j", async (fixture) => {
    const result = await run("publish", { tag: betaTag, ...fixture });
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(1);
  });

  it.each([
    { bundleAttempt: 1, witnessAttempt: 2, expiredWitness: false },
    { bundleAttempt: 2, witnessAttempt: 1, expiredWitness: false },
    { bundleAttempt: 2, witnessAttempt: 2, expiredWitness: true },
  ])("rejects stale or expired current-attempt Store artifacts: %j", async (artifact) => {
    const result = await run("publish", {
      tag: betaTag,
      artifacts: [
        { name: "openclaw-source-resolution", expired: false },
        {
          name: `openclaw-gateway-msix-store-submission-${artifact.bundleAttempt}`,
          expired: false,
        },
        {
          name: `store-release-source-${artifact.witnessAttempt}`,
          expired: artifact.expiredWitness,
        },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(1);
  });

  it.each([
    { tag: "v2026.10.7-alpha.1" },
    { tag: "v2026.9.33" },
    { tag: betaTag, release: { prerelease: false } },
    { release: { prerelease: true } },
  ])("rejects unsupported or misclassified releases before dispatch: %j", async (fixture) => {
    const result = await run("publish", fixture);
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
  });
});

describe("Gateway release workflow admission", () => {
  it.each(["openclaw-release-publish.yml", "openclaw-release-promote.yml"])(
    "admits only activated stable/latest and beta/beta releases in %s",
    (name) => {
      const workflow = parse(readFileSync(`.github/workflows/${name}`, "utf8")) as {
        jobs: Record<string, { if?: string; needs?: string[]; "continue-on-error"?: boolean }>;
      };
      const job = workflow.jobs.request_windows_gateway_release;
      const publisher = workflow.jobs.publish;
      if (!job || !publisher) {
        throw new Error("Gateway publication and Store request jobs must both exist");
      }
      for (const [selector, releaseTag, activated, expected] of [
        ["latest", tag, true, true],
        ["beta", tag, true, false],
        ["beta", "v2026.10.7-beta.2", true, true],
        ["extended-stable", "v2026.9.33", true, false],
        ["latest", "v2026.10.7-beta.1", true, false],
        ["latest", tag, false, false],
      ] as const) {
        const result = runInNewContext(job.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, "") ?? "false", {
          cancelled: () => false,
          contains: (value: string, search: string) => value.includes(search),
          inputs: { npm_dist_tag: selector, tag: releaseTag },
          needs: {
            finalize_github_release: { result: activated ? "success" : "failure" },
            finalize: { result: activated ? "success" : "failure" },
            publish: {
              result: "success",
              outputs: { npm_dist_tag: selector, release_tag: releaseTag },
            },
          },
        });
        expect(result).toBe(expected);
      }
      expect(job["continue-on-error"]).toBe(true);
      expect(publisher.needs ?? []).not.toContain("request_windows_gateway_release");
      expect(job.needs).toContain(
        name.includes("promote") ? "finalize" : "finalize_github_release",
      );
    },
  );
});

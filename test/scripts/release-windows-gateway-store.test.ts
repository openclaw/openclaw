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
const sha = "a".repeat(40);
const tooling = "b".repeat(40);
const packagingHead = "c".repeat(40);
const tag = "v2026.10.7";
const requestTitle = `Windows Gateway Store Request [${tag}] source=${sha}`;
const temps = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

type Dispatch = { endpoint: string; body: unknown };
type Fixture = {
  current?: Record<string, unknown>;
  release?: Record<string, unknown>;
  signedTag?: Record<string, unknown>;
  previous?: Record<string, unknown>[];
  source?: Record<string, unknown>;
  build?: Record<string, unknown>;
  automatic?: boolean | string;
  organizationAutomatic?: boolean | string;
  automaticAfterBuild?: string;
  largeHistory?: boolean;
  incompleteHistory?: boolean;
  expiredBundle?: boolean;
  ambiguousStore?: boolean;
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
  const directory = temps.make("windows-gateway-store-");
  const evidence = join(directory, "evidence.json");
  const dispatches: Dispatch[] = [];
  const parentPath =
    mode === "request" ? "openclaw-release-publish.yml" : "windows-gateway-store.yml";
  let requestCancelled = false;
  let buildPending = fixture.cancelDuringBuildWait ?? false;
  let buildObserved = false;
  pauseBuild.mockImplementation(async () => {
    requestCancelled = fixture.cancelDuringBuildWait ?? false;
  });
  process.argv = [process.execPath, "scripts/windows-gateway-store-release.mjs", mode];
  process.exitCode = undefined;
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: core,
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: tooling,
    RELEASE_TAG: tag,
    RELEASE_SHA: sha,
    WINDOWS_GATEWAY_STORE_EVIDENCE: evidence,
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
  })) {
    vi.stubEnv(name, value);
  }
  const source = {
    repository: `https://github.com/${core}`,
    requestedRef: sha,
    resolvedCommit: sha,
    packageVersion: "2026.10.7",
    workflowRunId: "51",
    packagingCommit: packagingHead,
    workflowRef: `${packaging}/.github/workflows/gateway-msix.yml@refs/heads/main`,
    githubRef: "refs/heads/main",
    eventName: "workflow_dispatch",
    signingMode: "store",
    releaseIdentitySource: {
      repository: `https://github.com/${core}`,
      resolvedCommit: sha,
      packageVersion: "2026.10.7",
      releaseTag: tag,
      channel: "stable",
    },
    ...fixture.source,
  };
  gh.mockImplementation((binary: string, args: string[], options: { input?: string }) => {
    expect(binary).toBe("gh");
    if (args[0] === "run") {
      const destination = args[args.indexOf("--dir") + 1];
      if (!destination) {
        throw new Error("Missing download directory");
      }
      writeFileSync(join(destination, "source-resolution.json"), JSON.stringify(source));
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
        : endpoint.includes("submit-microsoft-store")
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
    } else if (endpoint.endsWith(`/releases/tags/${tag}`)) {
      value = { tag_name: tag, draft: false, prerelease: false, ...fixture.release };
    } else if (endpoint.includes("/git/ref/tags/")) {
      value = { object: { type: "tag", sha: "d".repeat(40) } };
    } else if (endpoint.includes("/git/tags/")) {
      value = {
        tag,
        object: { type: "commit", sha },
        verification: { verified: true },
        ...fixture.signedTag,
      };
    } else if (endpoint.includes("windows-gateway-store.yml/runs")) {
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
    } else if (
      endpoint.includes("/actions/variables") ||
      endpoint.includes("/actions/organization-variables")
    ) {
      const automatic = endpoint.includes("/organization-variables")
        ? fixture.organizationAutomatic
        : buildObserved
          ? (fixture.automaticAfterBuild ?? fixture.automatic)
          : fixture.automatic;
      value = {
        items:
          automatic === undefined ? [] : [{ name: "MSSTORE_ENABLED", value: String(automatic) }],
        total_count: automatic === undefined ? 0 : 1,
      };
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
        status: buildPending ? "in_progress" : "completed",
        conclusion: "success",
        ...fixture.build,
      };
      buildPending = false;
      buildObserved = true;
    } else if (endpoint.includes("/artifacts?")) {
      value = {
        items: [
          { name: "openclaw-source-resolution", expired: false },
          {
            name: "openclaw-gateway-msix-store-submission",
            expired: fixture.expiredBundle ?? false,
          },
        ],
        total_count: 2,
      };
    } else {
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
    return JSON.stringify(value);
  });
  await import("../../scripts/windows-gateway-store-release.mjs");
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
          endpoint: `repos/${core}/actions/workflows/windows-gateway-store.yml/dispatches`,
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

  it("builds the exact payload and submits only that successful run", async () => {
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
        endpoint: `repos/${packaging}/actions/workflows/submit-microsoft-store.yml/dispatches`,
        body: { ref: "main", inputs: { run_id: "51" } },
      },
    ]);
    expect(result.evidence).toMatchObject({
      state: "store-requested",
      buildRunId: "51",
      storeRunId: "61",
    });
  });

  it("does not buffer oversized irrelevant run metadata while checking replay history", async () => {
    const result = await run("request", { largeHistory: true });
    expect(result.status).toBe(0);
    expect(result.evidence).toMatchObject({ state: "requested", requestRunId: "41" });
  });

  it("honors a repository override disabling inherited automatic Store submission", async () => {
    const result = await run("publish", { organizationAutomatic: "TrUe", automatic: "FaLsE" });
    expect(result.status).toBe(0);
    expect(result.evidence).toMatchObject({ state: "store-requested", storeRunId: "61" });
  });

  it.each([
    { automatic: "TRUE" },
    { automatic: "True" },
    { organizationAutomatic: "TRUE" },
    { organizationAutomatic: "TrUe" },
    { organizationAutomatic: false, automatic: "True" },
  ])("rejects mixed-case automatic Store submission before any dispatch: %j", async (fixture) => {
    const result = await run("publish", fixture);
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("MSSTORE_ENABLED must remain disabled"),
    );
  });

  it("does not request Store submission when automatic mode becomes mixed-case true during the build", async () => {
    const result = await run("publish", { automaticAfterBuild: "TrUe" });
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(1);
    expect(result.evidence).toMatchObject({ state: "building", buildRunId: "51" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("MSSTORE_ENABLED must remain disabled"),
    );
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
    { automatic: true },
    { organizationAutomatic: true },
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

  it("retains an attempted Store dispatch when acceptance is ambiguous", async () => {
    const result = await run("publish", { ambiguousStore: true });
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(2);
    expect(result.evidence).toMatchObject({ state: "store-dispatch-attempted", buildRunId: "51" });
    expect(result.evidence.storeRunId).toBeUndefined();
  });
});

describe("Gateway Store workflow admission", () => {
  it.each(["openclaw-release-publish.yml", "openclaw-release-promote.yml"])(
    "admits only activated stable/latest releases in %s",
    (name) => {
      const workflow = parse(readFileSync(`.github/workflows/${name}`, "utf8")) as {
        jobs: Record<string, { if?: string; needs?: string[]; "continue-on-error"?: boolean }>;
      };
      const job = workflow.jobs.request_windows_gateway_store;
      const publisher = workflow.jobs.publish;
      if (!job || !publisher) {
        throw new Error("Gateway publication and Store request jobs must both exist");
      }
      for (const [selector, releaseTag, activated, expected] of [
        ["latest", tag, true, true],
        ["beta", tag, true, false],
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
      expect(publisher.needs ?? []).not.toContain("request_windows_gateway_store");
      expect(job.needs).toContain(
        name.includes("promote") ? "finalize" : "finalize_github_release",
      );
    },
  );
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { gh } = vi.hoisted(() => ({ gh: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: gh }));
const nativeProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

const core = "openclaw/openclaw";
const packaging = "openclaw/openclaw-windows-packaging";
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
  largeHistory?: boolean;
  incompleteHistory?: boolean;
  ambiguousBuild?: boolean;
};

beforeEach(() => {
  vi.resetModules();
  gh.mockReset();
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
  const directory = temps.make("windows-gateway-release-");
  const evidence = join(directory, "evidence.json");
  const dispatches: Dispatch[] = [];
  const parentPath =
    mode === "request" ? "openclaw-release-publish.yml" : "windows-gateway-release.yml";
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
  gh.mockImplementation((binary: string, args: string[], options: { input?: string }) => {
    expect(binary).toBe("gh");
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    if (!endpoint) {
      throw new Error("Missing GitHub endpoint");
    }
    if (options.input) {
      dispatches.push({ endpoint, body: JSON.parse(options.input) });
      const id = endpoint.includes("gateway-msix.yml") ? 51 : 41;
      return JSON.stringify(fixture.ambiguousBuild ? {} : { workflow_run_id: id });
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
        status: "in_progress",
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

  it.each([tag, "v2026.10.7-beta.2"])(
    "starts an official %s release and lets build completion own Store approval",
    async (releaseTag) => {
      const result = await run("publish", { tag: releaseTag });
      expect(result.status).toBe(0);
      expect(result.dispatches).toEqual([
        {
          endpoint: `repos/${packaging}/actions/workflows/gateway-msix.yml/dispatches`,
          body: {
            ref: "main",
            inputs: {
              openclaw_ref: sha,
              ...(releaseTag.includes("-beta.")
                ? { release_channel: "beta", gateway_version: releaseTag.slice(1) }
                : {}),
              signing_mode: "official",
              publish_release: "true",
              request_store_publication: "true",
            },
          },
        },
      ]);
      expect(result.evidence).toMatchObject({ state: "building", buildRunId: "51" });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("publication is not complete yet"),
      );
      // Any attempt to poll or inspect the not-yet-completed build is rejected by
      // the fixture. This request must finish without consuming build lifetime.
    },
  );

  it("does not buffer oversized irrelevant run metadata while checking replay history", async () => {
    const result = await run("request", { largeHistory: true });
    expect(result.status).toBe(0);
    expect(result.evidence).toMatchObject({ state: "requested", requestRunId: "41" });
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

  it("retains an ambiguous build dispatch without starting another", async () => {
    const result = await run("publish", { ambiguousBuild: true });
    expect(result.status).toBe(1);
    expect(result.dispatches).toHaveLength(1);
    expect(result.evidence).toMatchObject({ state: "build-dispatch-attempted", packagingHead });
    expect(result.evidence.buildRunId).toBeUndefined();
  });

  it.each([
    { tag: "v2026.10.7-alpha.1" },
    { tag: "v2026.9.33" },
    { tag: "v2026.10.7-beta.2", release: { prerelease: false } },
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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { restoreCiAdaptivePriors } from "../../scripts/ci-adaptive-priors.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";

const repository = "openclaw/openclaw";
const revision = "a".repeat(40);
const tree = "b".repeat(40);
const consumerRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const consumerTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const cutoff = "2026-11-04T01:00:00Z";
const earlier = "2026-11-03T01:00:00Z";
const later = "2026-11-04T02:00:00Z";
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: "30",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_TOKEN: "synthetic-test-token",
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function bareRepository() {
  const root = tempDirs.make("ci-prior-tree-");
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: root,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init", "--bare"]);
  return { root, git };
}

function fixture(
  options: {
    artifacts?: number;
    compact?: boolean;
    consumerFork?: boolean;
    wrongConsumer?: boolean;
    sourceAttempt?: number;
    contextTree?: string;
    launchMismatch?: boolean;
    extraMember?: boolean;
    freshFork?: boolean;
    createdAt?: string;
    updatedAt?: string;
    digestMismatch?: boolean;
    conclusion?: string;
    freshConclusion?: string;
    comparison?: Record<string, unknown>;
    checkoutRevision?: string;
    treeResponse?: Record<string, unknown>;
  } = {},
) {
  const run = {
    id: 20,
    run_attempt: 1,
    head_sha: revision,
    head_branch: "main",
    event: "schedule",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: options.conclusion ?? "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    created_at: earlier,
    updated_at: earlier,
  };
  const context = { repository, revision, tree: options.contextTree ?? tree };
  const launch = JSON.stringify({ version: 1, runtime: "node" });
  const exported = {
    version: 1,
    source: { runId: "20", runAttempt: String(options.sourceAttempt ?? 1), event: "schedule" },
    preExecution: {
      observations: { version: 1, context, invocations: [] },
      launchInputs: { sha256: options.launchMismatch ? "0".repeat(64) : sha256(launch) },
    },
    observations: options.compact
      ? { version: 2, context, invocations: [], dependencyPaths: ["src/shared.ts"] }
      : { version: 1, context, invocations: [] },
  };
  const files: Record<string, string> = {};
  for (const runtime of ["node", "bun"]) {
    files[`${runtime}/observations.json`] = JSON.stringify(exported);
    files[`${runtime}/launch.json`] = launch;
  }
  if (options.extraMember) {
    files["unexpected.txt"] = "outside the observation contract";
  }
  const archive = makeStoredZip(files);
  const artifacts = Array.from({ length: options.artifacts ?? 1 }, (_, index) => ({
    id: index + 100,
    name: `ci-test-observations-20-1-${index}`,
    expired: false,
    created_at: options.createdAt ?? earlier,
    size_in_bytes: archive.length,
    digest: `sha256:${options.digestMismatch ? "0".repeat(64) : sha256(archive)}`,
    workflow_run: { id: run.id, head_sha: revision },
  }));
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.pathname);
    const endpoint = url.pathname.replace(`/repos/${repository}/`, "");
    let body: unknown;
    if (endpoint === "actions/runs/30/attempts/2") {
      body = {
        ...run,
        id: options.wrongConsumer ? 31 : 30,
        run_attempt: 2,
        event: "pull_request",
        created_at: cutoff,
        head_repository: { full_name: options.consumerFork ? "contributor/fork" : repository },
      };
    } else if (endpoint === "actions/workflows/ci.yml/runs") {
      expect(url.searchParams.get("status")).toBe("completed");
      body = { workflow_runs: [run] };
    } else if (endpoint === "actions/runs/20/artifacts") {
      body = { artifacts, total_count: artifacts.length };
    } else if (endpoint === "actions/runs/20/attempts/1") {
      body = {
        ...run,
        conclusion: options.freshConclusion ?? run.conclusion,
        updated_at: options.updatedAt ?? earlier,
        head_repository: { full_name: options.freshFork ? "contributor/fork" : repository },
      };
    } else if (
      endpoint === `compare/${revision}...${options.checkoutRevision ?? consumerRevision}`
    ) {
      body = {
        status: "ahead",
        behind_by: 0,
        base_commit: { sha: revision, commit: { tree: { sha: tree } } },
        merge_base_commit: { sha: revision },
        files: [
          { filename: "src/removed.ts", status: "removed" },
          { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
        ],
        ...options.comparison,
      };
    } else if (endpoint === `git/trees/${tree}`) {
      expect(url.searchParams.get("recursive")).toBe("1");
      body = options.treeResponse;
    } else if (/^actions\/artifacts\/\d+\/zip$/u.test(endpoint)) {
      return new Response(new Uint8Array(archive));
    } else {
      body = artifacts.find((artifact) => endpoint === `actions/artifacts/${artifact.id}`);
      if (!body) {
        throw new Error(`Unexpected request: ${endpoint}`);
      }
    }
    return Response.json(body);
  };
  return { fetchImpl, requests, exported, archive, files };
}

describe("adaptive CI prior restore", () => {
  it.each([486, 599, 600])("compares %i paths without the prior commit locally", async (count) => {
    const { root, git } = bareRepository();
    const blob = git(["hash-object", "-w", "--stdin"], "content");
    const paths = Array.from({ length: count - 6 }, (_, index) => `file-${index}`);
    const entries = [
      ...paths.map((path) => `100644 blob ${blob}\t${path}`),
      `100755 blob ${blob}\tmode`,
      `120000 blob ${blob}\tlink`,
      `160000 commit ${revision}\tmodule`,
      `100644 blob ${blob}\tnew-name`,
      `100644 blob ${blob}\treplace`,
    ];
    const headTree = git(["mktree", "--missing"], entries.join("\n") + "\n");
    const head = git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit-tree",
        headTree,
      ],
      "fixture\n",
    );
    git(["update-ref", "HEAD", head]);
    expect(() => git(["cat-file", "-e", revision])).toThrow();
    const leaf = (path: string, mode = "100644", type = "blob") => ({
      path,
      mode,
      type,
      sha: blob,
    });
    const f = fixture({
      checkoutRevision: head,
      comparison: { files: Array.from({ length: 300 }, () => ({ filename: "partial" })) },
      treeResponse: {
        sha: tree,
        truncated: false,
        padding: count === 486 ? "x".repeat(2 * 1024 * 1024) : "",
        tree: [
          ...paths.map((path) => ({ ...leaf(path), sha: "c".repeat(40) })),
          leaf("mode"),
          leaf("link", "120000"),
          leaf("module", "160000", "commit"),
          leaf("old-name"),
          leaf("replace", "040000", "tree"),
          leaf("replace/child"),
        ],
      },
    });
    // Same symlink bytes are unchanged; the gitlink changes its object ID.
    const bundle = await restoreCiAdaptivePriors({
      env,
      repositoryRoot: root,
      fetchImpl: f.fetchImpl,
    });
    if (count === 600) {
      expect(bundle.candidates).toEqual([]);
    } else {
      const comparison = {
        changedFiles: [
          ...paths,
          "mode",
          "module",
          "new-name",
          "old-name",
          "replace",
          "replace/child",
        ].toSorted(),
        headTree,
      };
      expect(bundle.candidates).toMatchObject([{ comparison }, { comparison }]);
    }
  });

  it.each([
    { truncated: true },
    { sha: "c".repeat(40) },
    { tree: [{ path: "../outside", mode: "100644", type: "blob", sha: revision }] },
    { tree: [{ path: "x", mode: "100644", type: "tree", sha: revision }] },
    {
      tree: Array.from({ length: 2 }, () => ({
        path: "x",
        mode: "100644",
        type: "blob",
        sha: revision,
      })),
    },
    { padding: "x".repeat(32 * 1024 * 1024) },
  ])("rejects incomplete or invalid large-diff trees ($truncated)", async (change) => {
    const { root, git } = bareRepository();
    const headTree = git(["mktree"], "");
    const head = git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit-tree",
        headTree,
      ],
      "fixture\n",
    );
    git(["update-ref", "HEAD", head]);
    const restore = (treeChange: Record<string, unknown> = {}) => {
      const f = fixture({
        checkoutRevision: head,
        comparison: { files: Array.from({ length: 300 }, () => ({ filename: "partial" })) },
        treeResponse: { sha: tree, truncated: false, tree: [], ...treeChange },
      });
      return restoreCiAdaptivePriors({ env, repositoryRoot: root, fetchImpl: f.fetchImpl });
    };
    // Keep the valid diff below the path limit so only the changed guard can reject it.
    expect((await restore()).candidates).toHaveLength(2);
    expect((await restore(change)).candidates).toEqual([]);
  });

  it("retains verified observations from a failed workflow without admitting cancelled runs", async () => {
    const failed = fixture({ conclusion: "failure" });
    expect(
      (await restoreCiAdaptivePriors({ env, fetchImpl: failed.fetchImpl })).candidates,
    ).toHaveLength(2);
    const cancelled = fixture({ conclusion: "cancelled" });
    expect(
      (await restoreCiAdaptivePriors({ env, fetchImpl: cancelled.fetchImpl })).candidates,
    ).toEqual([]);
    expect(cancelled.requests.some((request) => request.endsWith("/zip"))).toBe(false);
    const changed = fixture({ freshConclusion: "cancelled" });
    expect(
      (await restoreCiAdaptivePriors({ env, fetchImpl: changed.fetchImpl })).candidates,
    ).toEqual([]);
    expect(changed.requests.some((request) => request.endsWith("/zip"))).toBe(false);
  });

  it.each([false, true])("restores bounded source-bound archives (compact=%s)", async (compact) => {
    const f = fixture({ artifacts: 3, compact });
    const bundle = await restoreCiAdaptivePriors({ env, fetchImpl: f.fetchImpl });
    expect(bundle.consumer).toEqual({
      runId: "30",
      runAttempt: "2",
      revision: consumerRevision,
      tree: consumerTree,
    });
    expect(bundle.cutoffAt).toBe(cutoff);
    expect(bundle.candidates).toHaveLength(4);
    expect(bundle.fallbackReasons).toEqual([]);
    expect(f.requests.filter((request) => request.endsWith("/zip"))).toHaveLength(2);
    expect(f.requests.filter((request) => request.includes("/compare/"))).toHaveLength(1);
    expect(bundle.candidates[0]).toEqual({
      artifactId: 102,
      runId: 20,
      runAttempt: 1,
      createdAt: earlier,
      archiveSha256: sha256(f.archive),
      memberPath: "node/observations.json",
      memberSha256: sha256(JSON.stringify(f.exported)),
      observations: f.exported,
      comparison: {
        baseRevision: revision,
        baseTree: tree,
        headRevision: consumerRevision,
        headTree: consumerTree,
        changedFiles: ["src/new.ts", "src/old.ts", "src/removed.ts"],
      },
    });
    expect(JSON.stringify(bundle)).not.toContain(env.GITHUB_TOKEN);
  });

  it.each([
    ["source attempt", { sourceAttempt: 2 }],
    ["context tree", { contextTree: "c".repeat(40) }],
    ["launch binding", { launchMismatch: true }],
    ["unexpected archive member", { extraMember: true }],
    ["fresh fork provenance", { freshFork: true }],
    ["archive digest", { digestMismatch: true }],
    ["completion after cutoff", { updatedAt: later }],
    ["divergent history", { comparison: { merge_base_commit: { sha: "c".repeat(40) } } }],
    [
      "wrong comparison base",
      { comparison: { base_commit: { sha: "c".repeat(40), commit: { tree: { sha: tree } } } } },
    ],
    ["behind comparison", { comparison: { status: "behind", behind_by: 1 } }],
    [
      "saturated comparison",
      { comparison: { files: Array.from({ length: 300 }, () => ({ filename: "src/a.ts" })) } },
    ],
    ["incomplete rename", { comparison: { files: [{ filename: "src/a.ts", status: "renamed" }] } }],
    ["invalid comparison path", { comparison: { files: [{ filename: "../outside.ts" }] } }],
  ] as const)("discards a prior with invalid %s", async (_name, options) => {
    const f = fixture(options);
    const bundle = await restoreCiAdaptivePriors({ env, fetchImpl: f.fetchImpl });
    expect(bundle.candidates).toEqual([]);
    expect(bundle.fallbackReasons).toContain("prior-artifact-unavailable");
  });

  it("does not download an artifact created after the current run began", async () => {
    const f = fixture({ createdAt: later });
    const bundle = await restoreCiAdaptivePriors({ env, fetchImpl: f.fetchImpl });
    expect(bundle.candidates).toEqual([]);
    expect(f.requests.some((request) => request.endsWith("/zip"))).toBe(false);
  });

  it.each([{ consumerFork: true }, { wrongConsumer: true }])(
    "rejects another consumer identity",
    async (options) => {
      const f = fixture(options);
      const bundle = await restoreCiAdaptivePriors({ env, fetchImpl: f.fetchImpl });
      expect(bundle.candidates).toEqual([]);
      expect(f.requests).toHaveLength(1);
    },
  );

  it("uses no network without credentials and does not retry an unavailable API", async () => {
    const f = fixture();
    const unauthenticated = await restoreCiAdaptivePriors({
      env: { ...env, GITHUB_TOKEN: "" },
      fetchImpl: f.fetchImpl,
    });
    expect(unauthenticated.fallbackReasons).toEqual(["restore-context-unavailable"]);
    expect(f.requests).toEqual([]);
    let calls = 0;
    const failed = await restoreCiAdaptivePriors({
      env,
      fetchImpl: async () => {
        calls++;
        return new Response("unavailable", { status: 503 });
      },
    });
    expect(failed.candidates).toEqual([]);
    expect(failed.fallbackReasons).toEqual(["restore-unavailable"]);
    expect(failed.restoreFailure).toEqual({
      stage: "consumer-run",
      reason: "metadata-unavailable",
      status: 503,
    });
    expect(calls).toBe(1);
  });

  it("distinguishes invalid consumer metadata from transport failure without retaining error text", async () => {
    const invalid = fixture({ wrongConsumer: true });
    const rejected = await restoreCiAdaptivePriors({ env, fetchImpl: invalid.fetchImpl });
    expect(rejected.restoreFailure).toEqual({
      stage: "consumer-run",
      reason: "consumer-run-unavailable",
      status: null,
    });
    const failed = await restoreCiAdaptivePriors({
      env,
      fetchImpl: async () => {
        throw new Error(`transport error with ${env.GITHUB_TOKEN}`);
      },
    });
    expect(failed.restoreFailure).toEqual({
      stage: "consumer-run",
      reason: "request-failed",
      status: null,
    });
    for (const bundle of [rejected, failed]) {
      expect(bundle.cutoffAt).toBeNull();
      expect(bundle.candidates).toEqual([]);
      expect(JSON.stringify(bundle)).not.toContain(env.GITHUB_TOKEN);
    }
  });
});

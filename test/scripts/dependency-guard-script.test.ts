import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ERROR_BODY_MAX_BYTES,
  GITHUB_RESPONSE_BODY_MAX_BYTES,
  canAutoscrubPullRequest,
  createAutoscrubCommit,
  dependencyGuardCommentAuthors,
  dependencyFieldChanges,
  githubApi,
  isAutoscrubbedDependencyComment,
  isDependencyGuardMarkerComment,
  isRemovalOnlyDependencyGraphChange,
  readBoundedGitHubErrorText,
  renderBlockedDependencyComment,
  renderClearedDependencyGuardComment,
  renderRemovalOnlyDependencyComment,
  shouldAutoscrubDependencyLockfiles,
} from "../../scripts/github/dependency-guard.mjs";
import { loadSecurityReviewPolicy } from "../../scripts/github/security-review-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const headSha = "a".repeat(40);
const staleSha = "b".repeat(40);
const rolloutSha = "c".repeat(40);
const mergeBaseSha = "d".repeat(40);
const repoPath = "/repos/openclaw/openclaw";
const comparisonPath = `${repoPath}/compare/${staleSha}...${headSha}`;
const graphPath = `${repoPath}/dependency-graph/compare/${staleSha}...${headSha}`;
const statusPath = `${repoPath}/commits/${headSha}/statuses`;
const contentsPath = `${repoPath}/contents`;
const manifestPath = `${contentsPath}/package.json`;
const contributorPermission = `${repoPath}/collaborators/contributor/permission`;
const maintainerPermission = `${repoPath}/collaborators/maintainer/permission`;
const { isDependencyFile, isDependencyManifest, isPackageLockfile } = loadSecurityReviewPolicy();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function comparison(base = staleSha, mergeBase = base) {
  return { base_commit: { sha: base }, merge_base_commit: { sha: mergeBase } };
}
function contentFile(text: string) {
  return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") };
}
function manifestContent(version: string, test = "old") {
  return contentFile(JSON.stringify({ devDependencies: { example: version }, scripts: { test } }));
}
function afterTwoReads<T>(initial: T, latest: T) {
  return { responses: [initial, initial, latest] };
}
function changedDependencyFields(version: string, test: string) {
  return {
    optionalDependencies: { a: version },
    peerDependencies: { b: version },
    overrides: { c: version },
    packageManager: `pnpm@10.${version === "1" ? "0" : "1"}.0`,
    pnpm: { patchedDependencies: { d: `patches/d${version === "1" ? "" : "2"}.patch` } },
    scripts: { test },
  };
}
function connectionError(message = "terminated", code = "ECONNRESET", cause?: string) {
  return new TypeError(message, { cause: Object.assign(new Error(cause), { code }) });
}
function failedFetch(phase: string, error: Error, status?: number) {
  if (phase === "http") {
    return new Response("unicorn", { status, statusText: "Server Error" });
  }
  if (phase === "invalid-json") {
    return new Response("invalid JSON");
  }
  if (phase === "body") {
    return interruptedJsonResponse(error);
  }
  throw error;
}
function interruptedJsonResponse(error: Error) {
  let started = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        } else {
          controller.error(error);
        }
      },
    }),
  );
}

const pullPath = `${repoPath}/pulls/7`;
const issuePath = `${repoPath}/issues/7`;
const pullRequest = {
  number: 7,
  state: "open",
  draft: false,
  created_at: "2026-01-01T00:00:00Z",
  changed_files: 1,
  user: { id: 1, login: "contributor", type: "User" },
  base: { ref: "main", sha: staleSha, repo: { id: 1, full_name: "openclaw/openclaw" } },
  head: { ref: "change", sha: headSha, repo: { id: 1, full_name: "openclaw/openclaw" } },
};
const approval = {
  id: 11,
  body: "/allow-dependencies-change",
  created_at: "2026-01-01T00:00:01Z",
  updated_at: "2026-01-01T00:00:01Z",
  html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-11",
  user: { id: 2, login: "maintainer", type: "User" },
};
const approvalNotice = {
  id: 4,
  user: { login: "github-actions[bot]", type: "Bot" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  body: `<!-- openclaw:dependency-graph-guard -->\n<!-- openclaw:approval-request ${JSON.stringify({ head: headSha, base: "main", requestedAt: "2026-01-01T00:00:00Z" })} -->\n`,
};

function runDependencyGuard(
  routes: Record<string, unknown> = {},
  mode = "enforce",
  autoscrubToken: string | null = "fixture-autoscrub-token",
) {
  const dir = tempDirs.make("openclaw-dependency-guard-");
  const eventPath = path.join(dir, "event.json");
  const fixturePath = path.join(dir, "fixture.json");
  const logPath = path.join(dir, "requests.jsonl");
  const outputPath = path.join(dir, "output.txt");
  writeFileSync(outputPath, "");
  writeFileSync(
    eventPath,
    JSON.stringify({ repository: { default_branch: "main" }, pull_request: pullRequest }),
  );
  writeFileSync(logPath, "");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      logPath,
      routes: {
        [`GET ${pullPath}`]: pullRequest,
        [`GET ${statusPath}`]: [],
        "GET /repos/openclaw/openclaw/pulls/152415": {
          number: 152415,
          state: "closed",
          merged: true,
          merged_at: "2025-12-01T00:00:00Z",
          merge_commit_sha: rolloutSha,
          base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
        },
        [`GET ${pullPath}/files`]: [{ filename: "pnpm-workspace.yaml" }],
        [`GET ${comparisonPath}`]: comparison(),
        [`GET ${issuePath}/comments`]: [],
        [`GET ${issuePath}/labels`]: [],
        [`GET ${contributorPermission}`]: { role_name: "write" },
        [`GET ${maintainerPermission}`]: { role_name: "maintain" },
        ...routes,
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../fixtures/github-guard-fetch.mjs", import.meta.url)),
      fileURLToPath(new URL("../../scripts/github/dependency-guard.mjs", import.meta.url)),
    ],
    {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "fixture-token",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "1",
        GITHUB_OUTPUT: outputPath,
        OPENCLAW_GUARD_TEST_FIXTURE: fixturePath,
        OPENCLAW_DEPENDENCY_GUARD_MODE: mode,
        ...(autoscrubToken ? { OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN: autoscrubToken } : {}),
      },
    },
  );
  const calls: Array<{
    method: string;
    path: string;
    body?: { state?: string; body?: string; variables?: { input?: unknown } };
  }> = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    ...result,
    calls,
    output: readFileSync(outputPath, "utf8"),
    statuses: calls.filter((call) => call.path.includes("/statuses/")),
    writes: calls.filter((call) => call.path === "/graphql"),
  };
}
function expectGuard(
  result: ReturnType<typeof runDependencyGuard>,
  states: string[],
  status = 0,
  context: unknown = "",
) {
  expect(result.status, `${JSON.stringify(context)}: ${result.stderr}`).toBe(status);
  expect(result.statuses.map((call) => call.body?.state)).toEqual(states);
}
function expectGuardState(result: ReturnType<typeof runDependencyGuard>, state: string) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.statuses.at(-1)?.body?.state).toBe(state);
}

describe("dependency guard script", () => {
  it("does not transfer command approval to a duplicate PR with the same head", () => {
    const result = runDependencyGuard({
      [`GET ${issuePath}/comments`]: [approvalNotice, approval],
      [`GET ${statusPath}`]: [
        {
          context: "openclaw/ci-gate",
          description: "PR #8: Security review has not completed",
          creator: { login: "github-actions[bot]", type: "Bot" },
        },
      ],
      "GET /repos/openclaw/openclaw/pulls/8": { ...pullRequest, number: 8 },
    });
    expect(result.status).toBe(1);
    expect(result.statuses.map((call) => call.body?.state)).not.toContain("success");
    expect(result.statuses.at(-1)?.body?.state).toBe("failure");
  });

  it("requires current maintainer authority for dependency approval", () => {
    const early = "2025-12-31T00:00:00Z";
    const securityCommand = "/allow-security-sensitive-change";
    const cases: Array<[string, boolean, Partial<typeof approval> | null]> = [
      ["maintain", true, null],
      ["admin", true, null],
      ["maintain", true, {}],
      ["admin", true, {}],
      ["write", false, {}],
      ["maintain", false, { created_at: early, updated_at: early }],
      ["maintain", false, { updated_at: "2026-01-01T00:00:02Z" }],
      ["maintain", false, { user: { ...approval.user, type: "Bot" } }],
      ["maintain", false, { body: securityCommand }],
      ["maintain", true, { body: `${securityCommand}\n${approval.body}` }],
    ];
    for (const [role, allowed, overrides] of cases) {
      const author = overrides === null;
      const result = runDependencyGuard({
        [`GET /repos/openclaw/openclaw/collaborators/${author ? "contributor" : "maintainer"}/permission`]:
          { role_name: role },
        [`GET ${issuePath}/comments`]: author
          ? []
          : [approvalNotice, { ...approval, ...overrides }],
      });
      expectGuard(result, ["failure", allowed ? "success" : "failure"], 0, overrides);
      if (author) {
        expect(result.stdout).toContain("informational");
        expect(result.stdout).toContain("- `pnpm-workspace.yaml`\n");
      } else {
        expect(result.stdout).toContain(
          allowed ? "Dependency graph changes approved" : "Maintainer dependency review required",
        );
        expect(result.stdout).toContain("<!-- openclaw:approval-request ");
      }
    }
  });

  it("rechecks a command comment before publishing dependency success", () => {
    const result = runDependencyGuard({
      [`GET ${issuePath}/comments`]: afterTwoReads([approvalNotice, approval], [approvalNotice]),
    });
    expectGuardState(result, "failure");
    expect(result.stdout).toContain("Maintainer dependency review required");
  });

  it("requires review for renamed protected files and preserves lockfile artifacts", () => {
    const manifest = contentFile(JSON.stringify({ dependencies: { example: "1" } }));
    const cases: Array<[string, string, string?, boolean?]> = [
      ["archived.patch", "patches/package.patch", "patches/package.patch"],
      [
        "extensions/new/package.json",
        "extensions/old/package.json",
        "- `extensions/old/package.json`\n- `extensions/new/package.json`\n",
      ],
      ["fixtures/old-lockfile.txt", "pnpm-lock.yaml", undefined, true],
    ];
    for (const [filename, previous_filename, notice, detect] of cases) {
      const fixture: Record<string, unknown> = {
        [`GET ${pullPath}/files`]: [{ filename, previous_filename }],
      };
      if (previous_filename.endsWith("package.json") || detect) {
        fixture[`GET ${graphPath}`] = [
          { change_type: "removed", name: "example", manifest: previous_filename },
        ];
      }
      if (previous_filename.endsWith("package.json")) {
        for (const file of [filename, previous_filename]) {
          fixture[`GET ${contentsPath}/${file}`] = manifest;
        }
      }
      if (detect) {
        const detection = runDependencyGuard(fixture, "detect");
        expect(detection.status, detection.stderr).toBe(0);
        expect(detection.output).toBe("autoscrub=false\n");
        expect(detection.writes).toEqual([]);
      }
      const result = runDependencyGuard(fixture);
      expectGuardState(result, "failure");
      if (notice) {
        expect(result.stdout).toContain(notice);
      }
    }
  });

  it("evaluates manifest changes against the PR merge base", () => {
    const cases = [
      { role: "write", headVersion: "1", expected: "success", notice: false },
      { role: "admin", headVersion: "1", expected: "success", notice: false },
      { role: "write", headVersion: "2", expected: "failure", notice: true },
    ];
    for (const { role, headVersion, expected, notice } of cases) {
      const result = runDependencyGuard({
        [`GET ${pullPath}/files`]: [{ filename: "package.json" }],
        [`GET ${comparisonPath}`]: comparison(staleSha, mergeBaseSha),
        [`GET ${manifestPath}?ref=${mergeBaseSha}`]: manifestContent("1"),
        [`GET ${manifestPath}?ref=${headSha}`]: manifestContent(headVersion, "new"),
        [`GET ${graphPath}`]: [],
        [`GET ${contributorPermission}`]: { role_name: role },
      });
      expectGuardState(result, expected);
      expect(result.calls.some((call) => call.body?.body)).toBe(notice);
      if (notice) {
        expect(result.stdout).toContain("/allow-dependencies-change");
      }
    }
  });

  it("still detects added and removed manifests", () => {
    const cases = ["added", "removed"];
    for (const status of cases) {
      const content = contentFile(JSON.stringify({ dependencies: { example: "1" } }));
      const result = runDependencyGuard({
        [`GET ${pullPath}/files`]: [{ filename: "package.json", status }],
        [`GET ${manifestPath}?ref=${staleSha}`]: status === "added" ? { httpError: 404 } : content,
        [`GET ${manifestPath}?ref=${headSha}`]: status === "removed" ? { httpError: 404 } : content,
        [`GET ${graphPath}`]: [],
      });
      expectGuardState(result, "failure");
      expect(result.stdout).toContain("/allow-dependencies-change");
    }
  });

  it("fails closed when the manifest merge base is invalid", () => {
    const cases = [comparison(headSha, mergeBaseSha), comparison(staleSha, "invalid")];
    for (const invalidComparison of cases) {
      const result = runDependencyGuard({
        [`GET ${pullPath}/files`]: [{ filename: "package.json" }],
        [`GET ${comparisonPath}`]: invalidComparison,
      });
      expectGuard(result, ["failure"], 1);
      expect(result.stderr).toContain("merge base");
      expect(result.writes).toEqual([]);
    }
  });

  it("preserves autoscrub authority and reports rejected cleanup writes", () => {
    for (const outcome of ["cleanup", "late-approval", "write-error", "head-changed"]) {
      const lateApproval = outcome === "late-approval";
      const writeError = outcome === "write-error";
      const headChanged = outcome === "head-changed";
      const result = runDependencyGuard(
        {
          [`GET ${pullPath}`]: afterTwoReads(
            pullRequest,
            headChanged
              ? { ...pullRequest, head: { ...pullRequest.head, sha: staleSha } }
              : pullRequest,
          ),
          [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml" }],
          [`GET ${issuePath}/comments`]: afterTwoReads(
            [approvalNotice],
            lateApproval ? [approvalNotice, approval] : [approvalNotice],
          ),
          [`GET ${graphPath}`]: [],
          [`GET ${contentsPath}/pnpm-lock.yaml`]: contentFile("base lockfile"),
          "POST /graphql": writeError
            ? { httpError: 403 }
            : { data: { createCommitOnBranch: { commit: { oid: staleSha } } } },
        },
        "autoscrub",
      );
      expectGuard(result, ["failure"], writeError ? 1 : 0);
      if (writeError) {
        expect(result.stderr).toContain("Fixture API failure");
        expect(result.stdout).toContain(
          "Auto-scrub was attempted, but GitHub rejected the cleanup commit",
        );
      }
      const { writes } = result;
      expect(writes).toHaveLength(lateApproval || headChanged ? 0 : 1);
      if (headChanged) {
        expect(result.stdout).toContain("Superseded");
        expect(result.calls.some((call) => call.body?.body)).toBe(false);
        expect(result.stderr).not.toContain("Autoscrub failed");
      }
      if (!lateApproval && !headChanged) {
        expect(writes[0]?.body?.variables?.input).toMatchObject({
          expectedHeadOid: headSha,
          fileChanges: {
            additions: [
              { path: "pnpm-lock.yaml", contents: Buffer.from("base lockfile").toString("base64") },
            ],
          },
        });
      }
    }
  });

  it("restores modified, deleted, and added lockfiles from the PR merge base after main advances", () => {
    const content = contentFile;
    const result = runDependencyGuard(
      {
        [`GET ${pullPath}`]: { ...pullRequest, changed_files: 4 },
        [`GET ${pullPath}/files`]: [
          { filename: "pnpm-lock.yaml", status: "modified" },
          { filename: "tools/package-lock.json", status: "removed" },
          { filename: "new/package-lock.json", status: "added" },
          { filename: "README.md", status: "modified" },
        ],
        [`GET ${comparisonPath}`]: comparison(staleSha, mergeBaseSha),
        [`GET ${graphPath}`]: [],
        [`GET ${contentsPath}/pnpm-lock.yaml?ref=${mergeBaseSha}`]: content("original lockfile"),
        [`GET ${contentsPath}/tools/package-lock.json?ref=${mergeBaseSha}`]: content(
          "original nested lockfile",
        ),
        [`GET ${contentsPath}/new/package-lock.json?ref=${mergeBaseSha}`]: {
          httpError: 404,
        },
        "POST /graphql": { data: { createCommitOnBranch: { commit: { oid: rolloutSha } } } },
      },
      "autoscrub",
    );
    expect(result.status, result.stderr).toBe(0);
    const { writes } = result;
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body?.variables?.input).toEqual({
      branch: { repositoryNameWithOwner: "openclaw/openclaw", branchName: "change" },
      expectedHeadOid: headSha,
      fileChanges: {
        additions: [
          { path: "pnpm-lock.yaml", contents: content("original lockfile").content },
          {
            path: "tools/package-lock.json",
            contents: content("original nested lockfile").content,
          },
        ],
        deletions: [{ path: "new/package-lock.json" }],
      },
      message: { headline: "chore: remove dependency lockfile change" },
    });
    expect(result.stdout).toContain(`Merge base: \`${mergeBaseSha}\``);
    expect(result.stdout).not.toContain("Verification result:");
    expect(isAutoscrubbedDependencyComment({ body: result.stdout })).toBe(true);
  });

  it("keeps dependency approval required when an editable fork has no autoscrub token", () => {
    const routes = {
      [`GET ${pullPath}`]: {
        ...pullRequest,
        maintainer_can_modify: true,
        head: { ...pullRequest.head, repo: { id: 2, full_name: "contributor/openclaw" } },
      },
      [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml" }],
      [`GET ${graphPath}`]: [],
    };
    const autoscrub = runDependencyGuard(routes, "autoscrub", null);
    expectGuard(autoscrub, ["failure"]);
    expect(autoscrub.writes).toEqual([]);
    const notice = autoscrub.calls.find(
      (call) => call.path === `${issuePath}/comments` && call.method === "POST",
    );
    expect(notice?.body?.body).toContain("Automatic lockfile cleanup is best effort.");
    expect(notice?.body?.body).toContain("/allow-dependencies-change");
    expect(notice?.body?.body).toContain("git restore");

    const enforcement = runDependencyGuard(routes, "enforce", null);
    expectGuardState(enforcement, "failure");
    expect(enforcement.stdout).toContain("/allow-dependencies-change");
    expect(enforcement.stdout).toContain("Automatic lockfile cleanup is best effort.");
  });

  it("does not approve or autoscrub grandfathered lockfile PRs in any mode", () => {
    const cases = ["detect", "autoscrub", "enforce"];
    for (const mode of cases) {
      const result = runDependencyGuard(
        {
          [`GET ${pullPath}`]: { ...pullRequest, created_at: "2025-11-01T00:00:00Z" },
          [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml" }],
          [`GET ${repoPath}/compare/${rolloutSha}...${headSha}`]: {
            ...comparison(rolloutSha, staleSha),
            status: "diverged",
          },
        },
        mode,
      );
      expectGuard(result, []);
      expect(result.stdout).toContain("grandfathered");
      expect(result.calls.every((call) => call.method === "GET")).toBe(true);
    }
  });

  it("detects dependency guard file surfaces", () => {
    expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("package.json")).toBe(false);
    expect(isDependencyFile("ui/package.json")).toBe(false);
    expect(isDependencyFile("packages/core/package.json")).toBe(false);
    expect(isDependencyFile("qa/convex-credential-broker/package.json")).toBe(false);
    expect(isDependencyFile("package-lock.json")).toBe(true);
    expect(isDependencyFile("tools/nested/pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("src/index.ts")).toBe(false);
    expect(isPackageLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isPackageLockfile("package-lock.json")).toBe(true);
    expect(isPackageLockfile("package.json")).toBe(false);
  });

  it("compares package manifest fields that can affect dependency resolution", () => {
    expect(isDependencyManifest("package.json")).toBe(true);
    expect(isDependencyManifest("extensions/slack/package.json")).toBe(true);
    expect(isDependencyManifest("qa/convex-credential-broker/package.json")).toBe(true);
    expect(isDependencyManifest("src/index.ts")).toBe(false);
    expect(
      dependencyFieldChanges(
        { dependencies: { a: "1" }, devDependencies: { b: "1" } },
        { dependencies: { a: "2" }, devDependencies: { b: "1", c: "1" } },
      ),
    ).toEqual(["dependencies", "devDependencies"]);
    expect(
      dependencyFieldChanges(
        changedDependencyFields("1", "old"),
        changedDependencyFields("2", "new"),
      ),
    ).toEqual(["optionalDependencies", "peerDependencies", "overrides", "packageManager", "pnpm"]);
  });

  it("allows only dependency graph removals without approval", () => {
    const cases: Array<[string[], boolean]> = [
      [["removed", "removed"], true],
      [["removed", "added"], false],
      [[], false],
    ];
    for (const [changes, expected] of cases) {
      const graph = changes.map((change_type) => ({ change_type }));
      expect(isRemovalOnlyDependencyGraphChange(graph)).toBe(expected);
    }
  });

  it("renders dependency removals as informational", () => {
    const body = renderRemovalOnlyDependencyComment({
      dependencyGraphChanges: [
        {
          change_type: "removed",
          manifest: "extensions/example/package.json",
          name: "example-dependency",
        },
      ],
      headSha,
    });

    expect(body).toContain("Dependency removals noted");
    expect(body).toContain("does not require additional maintainer approval");
    expect(body).toContain("Removed `example-dependency`");
    expect(body).toContain("`extensions/example/package.json`");
    expect(body).toContain(headSha);
    expect(body).not.toContain("changes are blocked");
  });

  it("trusts only configured dependency guard marker comment authors", () => {
    const marker = "<!-- openclaw:dependency-graph-guard -->";
    const trustedAuthors = dependencyGuardCommentAuthors(
      "github-actions[bot], openclaw-autoscrub[bot]",
    );
    expect(dependencyGuardCommentAuthors(undefined)).toEqual(new Set(["github-actions[bot]"]));
    const cases: Array<[string, string, boolean]> = [
      ["openclaw-autoscrub[bot]", marker, true],
      ["contributor", marker, false],
      ["github-actions[bot]", "no marker", false],
    ];
    for (const [login, body, expected] of cases) {
      expect(
        isDependencyGuardMarkerComment({ body, user: { login } }, marker, trustedAuthors),
      ).toBe(expected);
    }
  });

  it("renders blocked cleanup guidance and shell-quotes PR-controlled paths", () => {
    type BlockedOptions = Partial<Parameters<typeof renderBlockedDependencyComment>[0]>;
    const cases: Array<[BlockedOptions, string[]]> = [
      [
        {
          baseBranch: "release/canary branch",
          lockfileChanges: [
            "dir with spaces/pnpm-lock.yaml",
            "safe/quote'$(touch bad);/package-lock.json",
          ],
        },
        [
          "git restore --source=\"$(git merge-base HEAD FETCH_HEAD)\" --staged --worktree -- 'dir with spaces/pnpm-lock.yaml' 'safe/quote'\\''$(touch bad);/package-lock.json'",
        ],
      ],
      [
        {
          autoscrubStatus: {
            kind: "blocked-by-dependency-manifest-fields",
            changes: [{ path: "package.json", fields: ["dependencies"] }],
          },
        },
        [
          "changes package manifest dependency graph fields",
          "- `package.json`\n",
          "Dependency graph changes require maintainer review",
        ],
      ],
      [
        {
          autoscrubStatus: {
            kind: "blocked-by-other-dependency-files",
            files: ["patches/example.patch", "pnpm-workspace.yaml"],
          },
        },
        [
          "also changes dependency-related files",
          "`patches/example.patch`",
          "`pnpm-workspace.yaml`",
        ],
      ],
    ];
    for (const [options, expected] of cases) {
      const body = renderBlockedDependencyComment({
        baseRepository: "openclaw/openclaw",
        baseBranch: "main",
        headSha,
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
        ...options,
      });
      for (const text of expected) {
        expect(body).toContain(text);
      }
    }
  });

  it("autoscrubs only lockfile changes with no dependency manifest changes", () => {
    const cases: Array<[string[], string[], Array<{ path: string; fields: string[] }>, boolean]> = [
      [["pnpm-lock.yaml"], ["pnpm-lock.yaml"], [], true],
      [
        ["pnpm-lock.yaml"],
        ["pnpm-lock.yaml"],
        [{ path: "package.json", fields: ["dependencies"] }],
        false,
      ],
      [[], [], [], false],
      [["pnpm-lock.yaml", "patches/example.patch"], ["pnpm-lock.yaml"], [], false],
    ];
    for (const [dependencyFiles, lockfileChanges, dependencyManifestChanges, expected] of cases) {
      expect(
        shouldAutoscrubDependencyLockfiles({
          dependencyFiles,
          lockfileChanges,
          dependencyManifestChanges,
        }),
      ).toBe(expected);
    }
  });

  it("attempts autoscrub on PR branches maintainers can modify", () => {
    const cases: Array<[string, boolean | undefined, boolean]> = [
      ["openclaw/openclaw", undefined, true],
      ["external/openclaw", undefined, false],
      ["external/openclaw", true, true],
    ];
    for (const [full_name, maintainer_can_modify, expected] of cases) {
      expect(
        canAutoscrubPullRequest({
          owner: "openclaw",
          repo: "openclaw",
          pullRequest: {
            maintainer_can_modify,
            head: { ref: "contributor/change", repo: { full_name }, sha: headSha },
          },
        }),
      ).toBe(expected);
    }
  });

  it("reads base lockfiles with the base API before writing autoscrub commits", async () => {
    const calls: Array<{ api: string; path: string; variables?: unknown }> = [];
    const baseApi = {
      request: async (requestPath: string) => {
        calls.push({ api: "base", path: requestPath });
        if (requestPath.includes("/compare/")) {
          return comparison(staleSha, mergeBaseSha);
        }
        if (requestPath.includes("/contents/pnpm-lock.yaml?")) {
          return { ...contentFile("base lockfile"), sha: "base-file" };
        }
        throw new Error(`unexpected base request: ${requestPath}`);
      },
    };
    const writeApi = {
      graphql: async (_query: string, variables: unknown) => {
        calls.push({ api: "write", path: "graphql", variables });
        return { createCommitOnBranch: { commit: { oid: staleSha } } };
      },
    };

    const autoscrubPullRequest = pullRequest;
    const guard = {
      owner: "openclaw",
      repo: "openclaw",
      pullRequest: autoscrubPullRequest,
      pullPath,
      issuePath,
      commentMarker: "<!-- openclaw:dependency-graph-guard -->",
      approvalCommand: "/allow-dependencies-change",
      api: {
        request: async (requestPath: string) =>
          requestPath.endsWith("/permission") ? { role_name: "read" } : autoscrubPullRequest,
        paginate: async (requestPath: string) => {
          if (requestPath === `${issuePath}/comments`) {
            return [];
          }
          throw new Error(`unexpected guard request: ${requestPath}`);
        },
      },
    };
    const commit = await createAutoscrubCommit(
      { baseApi, writeApi, guard },
      {
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: autoscrubPullRequest,
        lockfileChanges: ["pnpm-lock.yaml"],
        targetRepository: { owner: "contributor", repo: "openclaw" },
      },
    );

    expect(commit).toEqual({ sha: staleSha, mergeBaseSha });
    expect(calls.map((call) => `${call.api}:${call.path}`)).toEqual([
      `base:${comparisonPath}?per_page=1&page=2`,
      `base:/repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=${mergeBaseSha}`,
      "write:graphql",
    ]);
    expect(calls[2]?.variables).toMatchObject({
      input: {
        branch: {
          repositoryNameWithOwner: "contributor/openclaw",
          branchName: "change",
        },
        expectedHeadOid: headSha,
        fileChanges: {
          additions: [
            {
              contents: Buffer.from("base lockfile").toString("base64"),
              path: "pnpm-lock.yaml",
            },
          ],
          deletions: [],
        },
      },
    });
  });

  it("renders a cleared guard comment that preserves approval freshness", () => {
    const body = renderClearedDependencyGuardComment({ headSha });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency graph guard cleared");
    expect(body).toContain(headSha);
    expect(body).toContain("requires a maintainer's `/allow-dependencies-change` comment");
  });

  it("bounds GitHub response bodies while preserving error status", async () => {
    for (const kind of ["error-header", "error-stream", "success"]) {
      const limit = kind === "success" ? 64 : GITHUB_ERROR_BODY_MAX_BYTES;
      const response =
        kind === "error-stream"
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(limit + 1));
                  controller.close();
                },
              }),
              { status: 403, statusText: "Forbidden" },
            )
          : new Response(kind === "error-header" ? "ignored" : "x".repeat(limit + 1), {
              headers: { "content-length": String(limit + 1) },
            });
      if (kind === "error-header") {
        await expect(readBoundedGitHubErrorText(response)).rejects.toThrow(
          `GitHub error response body exceeded ${limit} bytes`,
        );
        continue;
      }
      const request = githubApi("token", {
        responseMaxBodyBytes: limit,
        fetchImpl: async () => response,
      }).request("/repos/openclaw/openclaw");
      if (kind === "error-stream") {
        await expect(request).rejects.toMatchObject({
          message: `GitHub API GET /repos/openclaw/openclaw failed: 403 Forbidden: GitHub error response body exceeded ${limit} bytes`,
          status: 403,
        });
      } else {
        await expect(request).rejects.toThrow("GitHub response body exceeded 64 bytes");
        expect(GITHUB_RESPONSE_BODY_MAX_BYTES).toBeGreaterThan(64);
      }
    }
  });

  it("retries transient reads within one connection, HTTP, and body budget", async () => {
    const cases: Array<[method: string, phase: string, failure: number | string]> = [
      ["GET", "http", 500],
      ["HEAD", "http", 500],
      ["GET", "connection", "ECONNRESET"],
      ["GET", "body", "UND_ERR_SOCKET"],
      ["GET", "budget", "ECONNRESET"],
    ];
    for (const [method, phase, failure] of cases) {
      const error = connectionError(
        "terminated",
        String(failure),
        phase === "budget" ? "connection reset" : undefined,
      );
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () =>
          failedFetch(phase, error, typeof failure === "number" ? failure : undefined),
        );
      const responseBody = phase === "http" ? { ok: true } : { complete: true };
      if (phase === "budget") {
        fetchImpl
          .mockResolvedValueOnce(new Response(null, { status: 503 }))
          .mockImplementation(async () => interruptedJsonResponse(error));
      } else {
        fetchImpl.mockResolvedValueOnce(
          method === "HEAD" ? new Response(null, { status: 204 }) : Response.json(responseBody),
        );
      }
      const request = githubApi("token", {
        fetchImpl,
        retryDelaysMs: phase === "budget" ? [0, 0, 0] : [0],
      }).request(phase === "http" ? "/repos/openclaw/openclaw/pulls/1/files" : pullPath, {
        method,
      });
      if (phase === "budget") {
        await expect(request).rejects.toMatchObject({
          message: expect.stringContaining(`GitHub API GET ${pullPath} failed: ECONNRESET`),
          cause: error,
        });
      } else {
        await expect(request).resolves.toEqual(method === "HEAD" ? null : responseBody);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(phase === "budget" ? 4 : 2);
    }
  });

  it("never replays writes, aborted requests, or non-transient failures", async () => {
    type FailureOptions = {
      status?: number;
      code?: string;
      error?: Error;
      abort?: boolean;
      matchMessage?: boolean;
    };
    const reset = { code: "ECONNRESET", matchMessage: true };
    const aborted = { code: "ECONNRESET", abort: true };
    const certificate = connectionError("fetch failed", "CERT_HAS_EXPIRED", "certificate expired");
    const cases: Array<[string, string, FailureOptions?]> = [
      ["POST", "http", { status: 500 }],
      ["POST", "body", { code: "UND_ERR_SOCKET", matchMessage: true }],
      ["GET", "invalid-json"],
      ["GET", "body", { error: new Error("unknown stream error") }],
      ["POST", "connection", reset],
      ["GET", "connection", { error: new DOMException("aborted", "AbortError") }],
      ["GET", "connection", { error: certificate }],
      ["GET", "connection", { error: new TypeError("invalid request") }],
      ["GET", "connection", aborted],
      ["GET", "body", aborted],
    ];
    for (const [method, phase, options = {}] of cases) {
      const { status, code, error: suppliedError, abort, matchMessage } = options;
      const controller = new AbortController();
      const error =
        suppliedError ??
        connectionError(
          phase === "body" && !abort ? "terminated" : "fetch failed",
          code,
          abort || phase === "body" ? undefined : "connection reset",
        );
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (abort) {
          controller.abort(error);
        }
        return failedFetch(phase, error, status);
      });
      const requestPath =
        abort || method === "GET"
          ? pullPath
          : phase === "http"
            ? "/repos/openclaw/openclaw/issues/1/comments"
            : issuePath;
      const request = githubApi("token", {
        fetchImpl,
        ...(phase === "http" ? { retryDelaysMs: [0] } : {}),
      }).request(requestPath, {
        method,
        ...(abort ? { signal: controller.signal } : method === "GET" ? {} : { body: "{}" }),
      });
      if (phase === "http") {
        await expect(request).rejects.toMatchObject({
          status,
          message: `GitHub API ${method} ${requestPath} failed: ${status} Server Error: unicorn`,
        });
      } else if (phase === "invalid-json" || (phase === "body" && suppliedError)) {
        await expect(request).rejects.toThrow();
      } else {
        await expect(request).rejects.toMatchObject({
          cause: error,
          ...(matchMessage
            ? {
                message: expect.stringContaining(
                  `GitHub API ${method} ${requestPath} failed: ${code}`,
                ),
              }
            : {}),
        });
        if (abort) {
          await expect(request).rejects.not.toHaveProperty("code");
        }
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps request timeouts active during fetch, body reads, and retry backoff", async () => {
    for (const phase of ["fetch", "body", "connection-backoff", "body-backoff"]) {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        const fetchStarted = Promise.withResolvers<void>();
        const backoff = phase.endsWith("-backoff");
        const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
          signal = init?.signal ?? undefined;
          fetchStarted.resolve();
          if (phase === "fetch") {
            return await new Promise<Response>(() => {});
          }
          if (phase === "body") {
            return new Response(new ReadableStream({ start() {} }), {
              headers: { "content-type": "application/json" },
            });
          }
          const error = connectionError();
          if (phase === "body-backoff") {
            return interruptedJsonResponse(error);
          }
          throw error;
        });
        const requestPath = backoff ? pullPath : "/repos/openclaw/openclaw";
        const request = githubApi("token", {
          fetchImpl,
          timeoutMs: 5,
          ...(backoff ? { retryDelaysMs: [10_000] } : {}),
        }).request(requestPath);
        const rejection = expect(request).rejects.toThrow(
          `GitHub API GET ${requestPath} exceeded timeout 5ms`,
        );
        await fetchStarted.promise;
        await vi.advanceTimersByTimeAsync(5);
        await rejection;
        expect(signal?.aborted).toBe(true);
        if (backoff) {
          expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });
});

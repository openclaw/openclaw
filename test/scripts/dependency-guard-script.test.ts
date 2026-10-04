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
  renderAutoscrubbedDependencyComment,
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
const comparisonPath = `/repos/openclaw/openclaw/compare/${staleSha}...${headSha}`;
const { isDependencyFile, isDependencyManifest, isPackageLockfile } = loadSecurityReviewPolicy();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function contentFile(text: string) {
  return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") };
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

const pullPath = "/repos/openclaw/openclaw/pulls/7";
const issuePath = "/repos/openclaw/openclaw/issues/7";
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
        [`GET /repos/openclaw/openclaw/commits/${headSha}/statuses`]: [],
        "GET /repos/openclaw/openclaw/pulls/152415": {
          number: 152415,
          state: "closed",
          merged: true,
          merged_at: "2025-12-01T00:00:00Z",
          merge_commit_sha: rolloutSha,
          base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
        },
        [`GET ${pullPath}/files`]: [{ filename: "pnpm-workspace.yaml" }],
        [`GET ${comparisonPath}`]: {
          base_commit: { sha: staleSha },
          merge_base_commit: { sha: staleSha },
        },
        [`GET ${issuePath}/comments`]: [],
        [`GET ${issuePath}/labels`]: [],
        "GET /repos/openclaw/openclaw/collaborators/contributor/permission": { role_name: "write" },
        "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": {
          role_name: "maintain",
        },
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
  };
}

describe("dependency guard script", () => {
  it("does not transfer command approval to a duplicate PR with the same head", () => {
    const result = runDependencyGuard({
      [`GET ${issuePath}/comments`]: [approvalNotice, approval],
      [`GET /repos/openclaw/openclaw/commits/${headSha}/statuses`]: [
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
    const cases: Array<{
      name: string;
      comment?: typeof approval;
      role: string;
      allowed: boolean;
      author?: boolean;
    }> = [
      { name: "maintainer author", role: "maintain", allowed: true, author: true },
      { name: "admin author", role: "admin", allowed: true, author: true },
      { name: "current maintainer command", comment: approval, role: "maintain", allowed: true },
      { name: "current admin command", comment: approval, role: "admin", allowed: true },
      { name: "write-only commenter", comment: approval, role: "write", allowed: false },
      {
        name: "command before the current request",
        comment: {
          ...approval,
          created_at: "2025-12-31T00:00:00Z",
          updated_at: "2025-12-31T00:00:00Z",
        },
        role: "maintain",
        allowed: false,
      },
      {
        name: "edited comment",
        comment: { ...approval, updated_at: "2026-01-01T00:00:02Z" },
        role: "maintain",
        allowed: false,
      },
      {
        name: "bot command",
        comment: { ...approval, user: { ...approval.user, type: "Bot" } },
        role: "maintain",
        allowed: false,
      },
      {
        name: "security-only command",
        comment: { ...approval, body: "/allow-security-sensitive-change" },
        role: "maintain",
        allowed: false,
      },
      {
        name: "both commands on separate lines",
        comment: {
          ...approval,
          body: "/allow-security-sensitive-change\n/allow-dependencies-change",
        },
        role: "maintain",
        allowed: true,
      },
    ];
    for (const { name, comment, role, allowed, author } of cases) {
      const result = runDependencyGuard({
        [`GET /repos/openclaw/openclaw/collaborators/${author ? "contributor" : "maintainer"}/permission`]:
          { role_name: role },
        [`GET ${issuePath}/comments`]: author ? [] : [approvalNotice, comment],
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      expect(result.statuses.map((call) => call.body?.state)).toEqual([
        "failure",
        allowed ? "success" : "failure",
      ]);
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
      [`GET ${issuePath}/comments`]: {
        responses: [[approvalNotice, approval], [approvalNotice, approval], [approvalNotice]],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses.at(-1)?.body?.state).toBe("failure");
    expect(result.stdout).toContain("Maintainer dependency review required");
  });

  it("requires review for renamed protected files and preserves lockfile artifacts", () => {
    const manifest = contentFile(JSON.stringify({ dependencies: { example: "1" } }));
    const cases: Array<{
      filename: string;
      previous_filename: string;
      routes?: Record<string, unknown>;
      notice?: string;
      detect?: boolean;
    }> = [
      {
        filename: "archived.patch",
        previous_filename: "patches/package.patch",
        notice: "patches/package.patch",
      },
      {
        filename: "extensions/new/package.json",
        previous_filename: "extensions/old/package.json",
        notice: "- `extensions/old/package.json`\n- `extensions/new/package.json`\n",
        routes: {
          "GET /repos/openclaw/openclaw/contents/extensions/old/package.json": manifest,
          "GET /repos/openclaw/openclaw/contents/extensions/new/package.json": manifest,
          [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [
            { change_type: "removed", name: "example", manifest: "extensions/old/package.json" },
          ],
        },
      },
      {
        filename: "fixtures/old-lockfile.txt",
        previous_filename: "pnpm-lock.yaml",
        detect: true,
        routes: {
          [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [
            { change_type: "removed", name: "example", manifest: "pnpm-lock.yaml" },
          ],
        },
      },
    ];
    for (const { filename, previous_filename, routes, notice, detect } of cases) {
      const fixture = { [`GET ${pullPath}/files`]: [{ filename, previous_filename }], ...routes };
      if (detect) {
        const detection = runDependencyGuard(fixture, "detect");
        expect(detection.status, detection.stderr).toBe(0);
        expect(detection.output).toBe("autoscrub=false\n");
        expect(detection.calls.some((call) => call.path === "/graphql")).toBe(false);
      }
      const result = runDependencyGuard(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.statuses.at(-1)?.body?.state).toBe("failure");
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
      const content = (version: string, test: string) =>
        contentFile(JSON.stringify({ devDependencies: { example: version }, scripts: { test } }));
      const manifestPath = "/repos/openclaw/openclaw/contents/package.json";
      const result = runDependencyGuard({
        [`GET ${pullPath}/files`]: [{ filename: "package.json" }],
        [`GET ${comparisonPath}`]: {
          base_commit: { sha: staleSha },
          merge_base_commit: { sha: mergeBaseSha },
        },
        [`GET ${manifestPath}?ref=${mergeBaseSha}`]: content("1", "old"),
        [`GET ${manifestPath}?ref=${staleSha}`]: content("2", "old"),
        [`GET ${manifestPath}?ref=${headSha}`]: content(headVersion, "new"),
        [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [],
        "GET /repos/openclaw/openclaw/collaborators/contributor/permission": { role_name: role },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.statuses.at(-1)?.body?.state).toBe(expected);
      expect(result.calls.some((call) => call.body?.body)).toBe(notice);
      if (notice) {
        expect(result.stdout).toContain("/allow-dependencies-change");
      }
    }
  });

  it("still detects added and removed manifests", () => {
    const cases = ["added", "removed"];
    for (const status of cases) {
      const manifestPath = "/repos/openclaw/openclaw/contents/package.json";
      const content = contentFile(JSON.stringify({ dependencies: { example: "1" } }));
      const result = runDependencyGuard({
        [`GET ${pullPath}/files`]: [{ filename: "package.json", status }],
        [`GET ${manifestPath}?ref=${staleSha}`]: status === "added" ? { httpError: 404 } : content,
        [`GET ${manifestPath}?ref=${headSha}`]: status === "removed" ? { httpError: 404 } : content,
        [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.statuses.at(-1)?.body?.state).toBe("failure");
      expect(result.stdout).toContain("/allow-dependencies-change");
    }
  });

  it("fails closed when the manifest merge base is invalid", () => {
    const cases = [
      { base_commit: { sha: headSha }, merge_base_commit: { sha: mergeBaseSha } },
      { base_commit: { sha: staleSha }, merge_base_commit: { sha: "invalid" } },
    ];
    for (const comparison of cases) {
      const result = runDependencyGuard({
        [`GET ${pullPath}/files`]: [{ filename: "package.json" }],
        [`GET ${comparisonPath}`]: comparison,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("merge base");
      expect(result.statuses.map((call) => call.body?.state)).toEqual(["failure"]);
      expect(result.calls.some((call) => call.path === "/graphql")).toBe(false);
    }
  });

  it("preserves autoscrub authority and reports rejected cleanup writes", () => {
    const cases = [
      { lateApproval: false, writeError: false, headChanged: false },
      { lateApproval: true, writeError: false, headChanged: false },
      { lateApproval: false, writeError: true, headChanged: false },
      { lateApproval: false, writeError: false, headChanged: true },
    ];
    for (const { lateApproval, writeError, headChanged } of cases) {
      const result = runDependencyGuard(
        {
          [`GET ${pullPath}`]: {
            responses: [
              pullRequest,
              pullRequest,
              headChanged
                ? { ...pullRequest, head: { ...pullRequest.head, sha: staleSha } }
                : pullRequest,
            ],
          },
          [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml" }],
          [`GET ${issuePath}/comments`]: {
            responses: [
              [approvalNotice],
              [approvalNotice],
              lateApproval ? [approvalNotice, approval] : [approvalNotice],
            ],
          },
          [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [],
          "GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml": contentFile("base lockfile"),
          "POST /graphql": writeError
            ? { httpError: 403 }
            : { data: { createCommitOnBranch: { commit: { oid: staleSha } } } },
        },
        "autoscrub",
      );
      expect(result.status, result.stderr).toBe(writeError ? 1 : 0);
      if (writeError) {
        expect(result.stderr).toContain("Fixture API failure");
        expect(result.stdout).toContain(
          "Auto-scrub was attempted, but GitHub rejected the cleanup commit",
        );
      }
      const writes = result.calls.filter((call) => call.path === "/graphql");
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
      expect(result.statuses.map((call) => call.body?.state)).toEqual(["failure"]);
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
        [`GET ${comparisonPath}`]: {
          base_commit: { sha: staleSha },
          merge_base_commit: { sha: mergeBaseSha },
        },
        [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [],
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=${mergeBaseSha}`]:
          content("original lockfile"),
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=${staleSha}`]:
          content("unrelated main update"),
        [`GET /repos/openclaw/openclaw/contents/tools/package-lock.json?ref=${mergeBaseSha}`]:
          content("original nested lockfile"),
        [`GET /repos/openclaw/openclaw/contents/tools/package-lock.json?ref=${staleSha}`]: {
          httpError: 404,
        },
        [`GET /repos/openclaw/openclaw/contents/new/package-lock.json?ref=${mergeBaseSha}`]: {
          httpError: 404,
        },
        [`GET /repos/openclaw/openclaw/contents/new/package-lock.json?ref=${staleSha}`]: content(
          "independently added on main",
        ),
        "POST /graphql": { data: { createCommitOnBranch: { commit: { oid: rolloutSha } } } },
      },
      "autoscrub",
    );
    expect(result.status, result.stderr).toBe(0);
    const writes = result.calls.filter((call) => call.path === "/graphql");
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
  });

  it("keeps dependency approval required when an editable fork has no autoscrub token", () => {
    const routes = {
      [`GET ${pullPath}`]: {
        ...pullRequest,
        maintainer_can_modify: true,
        head: { ...pullRequest.head, repo: { id: 2, full_name: "contributor/openclaw" } },
      },
      [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml" }],
      [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [],
    };
    const autoscrub = runDependencyGuard(routes, "autoscrub", null);
    expect(autoscrub.status, autoscrub.stderr).toBe(0);
    expect(autoscrub.calls.some((call) => call.path === "/graphql")).toBe(false);
    expect(autoscrub.statuses.map((call) => call.body?.state)).toEqual(["failure"]);
    const notice = autoscrub.calls.find(
      (call) => call.path === `${issuePath}/comments` && call.method === "POST",
    );
    expect(notice?.body?.body).toContain("Automatic lockfile cleanup is best effort.");
    expect(notice?.body?.body).toContain("/allow-dependencies-change");
    expect(notice?.body?.body).toContain("git restore");

    const enforcement = runDependencyGuard(routes, "enforce", null);
    expect(enforcement.status, enforcement.stderr).toBe(0);
    expect(enforcement.statuses.at(-1)?.body?.state).toBe("failure");
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
          [`GET /repos/openclaw/openclaw/compare/${rolloutSha}...${headSha}`]: {
            base_commit: { sha: rolloutSha },
            merge_base_commit: { sha: staleSha },
            status: "diverged",
          },
        },
        mode,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("grandfathered");
      expect(result.statuses).toEqual([]);
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
        { scripts: { test: "old" }, dependencies: { a: "1" } },
        { scripts: { test: "new" }, dependencies: { a: "1" } },
      ),
    ).toEqual([]);
    expect(
      dependencyFieldChanges(
        { dependencies: { a: "1" }, devDependencies: { b: "1" } },
        { dependencies: { a: "2" }, devDependencies: { b: "1", c: "1" } },
      ),
    ).toEqual(["dependencies", "devDependencies"]);
    expect(
      dependencyFieldChanges(
        {
          optionalDependencies: { a: "1" },
          peerDependencies: { b: "1" },
          overrides: { c: "1" },
          packageManager: "pnpm@10.0.0",
          pnpm: { patchedDependencies: { d: "patches/d.patch" } },
          scripts: { test: "old" },
        },
        {
          optionalDependencies: { a: "2" },
          peerDependencies: { b: "2" },
          overrides: { c: "2" },
          packageManager: "pnpm@10.1.0",
          pnpm: { patchedDependencies: { d: "patches/d2.patch" } },
          scripts: { test: "new" },
        },
      ),
    ).toEqual(["optionalDependencies", "peerDependencies", "overrides", "packageManager", "pnpm"]);
  });

  it("allows only dependency graph removals without approval", () => {
    expect(
      isRemovalOnlyDependencyGraphChange([
        { change_type: "removed", name: "a" },
        { change_type: "removed", name: "b" },
      ]),
    ).toBe(true);
    expect(
      isRemovalOnlyDependencyGraphChange([
        { change_type: "removed", name: "a" },
        { change_type: "added", name: "b" },
      ]),
    ).toBe(false);
    expect(isRemovalOnlyDependencyGraphChange([{ change_type: "changed", name: "a" }])).toBe(false);
    expect(isRemovalOnlyDependencyGraphChange([])).toBe(false);
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
    const cases: Array<{
      options: Partial<Parameters<typeof renderBlockedDependencyComment>[0]>;
      expected: string[];
    }> = [
      {
        options: {
          lockfileChanges: ["pnpm-lock.yaml", "tools/nested/pnpm-lock.yaml"],
          dependencyManifestChanges: [{ path: "package.json", fields: ["dependencies"] }],
        },
        expected: [
          "<!-- openclaw:dependency-graph-guard -->",
          "Maintainer dependency review required",
          "- `pnpm-lock.yaml`\n",
          "- `tools/nested/pnpm-lock.yaml`\n",
          "- `package.json`\n",
          "git restore --source=\"$(git merge-base HEAD FETCH_HEAD)\" --staged --worktree -- 'pnpm-lock.yaml' 'tools/nested/pnpm-lock.yaml'",
          "git fetch 'https://github.com/openclaw/openclaw.git' 'main'",
          "```text\n/allow-dependencies-change\n```",
          `Current SHA: \`${headSha}\``,
          "A later push requires a fresh approval comment.",
        ],
      },
      {
        options: {
          baseBranch: "release/canary branch",
          lockfileChanges: [
            "dir with spaces/pnpm-lock.yaml",
            "safe/quote'$(touch bad);/package-lock.json",
          ],
        },
        expected: [
          "git restore --source=\"$(git merge-base HEAD FETCH_HEAD)\" --staged --worktree -- 'dir with spaces/pnpm-lock.yaml' 'safe/quote'\\''$(touch bad);/package-lock.json'",
        ],
      },
      {
        options: { autoscrubStatus: { kind: "unavailable" } },
        expected: [
          "Automatic lockfile cleanup is best effort.",
          "These lockfile changes remain in this PR.",
        ],
      },
      {
        options: {
          autoscrubStatus: {
            kind: "blocked-by-dependency-manifest-fields",
            changes: [{ path: "package.json", fields: ["dependencies"] }],
          },
        },
        expected: [
          "changes package manifest dependency graph fields",
          "- `package.json`\n",
          "Dependency graph changes require maintainer review",
        ],
      },
      {
        options: {
          autoscrubStatus: {
            kind: "blocked-by-other-dependency-files",
            files: ["patches/example.patch", "pnpm-workspace.yaml"],
          },
        },
        expected: [
          "also changes dependency-related files",
          "`patches/example.patch`",
          "`pnpm-workspace.yaml`",
        ],
      },
    ];
    for (const { options, expected } of cases) {
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
      [["pnpm-lock.yaml", "pnpm-workspace.yaml"], ["pnpm-lock.yaml"], [], false],
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

  it("renders deterministic autoscrub success comments", () => {
    const body = renderAutoscrubbedDependencyComment({
      baseBranch: "main",
      commitSha: staleSha,
      mergeBaseSha,
      lockfileChanges: ["pnpm-lock.yaml", "tools/nested/pnpm-lock.yaml"],
    });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency lockfile changes were removed");
    expect(body).toContain("did not change dependency graph fields in package manifests");
    expect(body).toContain("`pnpm-lock.yaml`");
    expect(body).toContain("`tools/nested/pnpm-lock.yaml`");
    expect(body).toContain(`Cleanup commit: \`${staleSha}\``);
    expect(body).toContain(
      "restored each listed lockfile to its merge-base state, removing files added by this PR",
    );
    expect(body).toContain(`Merge base: \`${mergeBaseSha}\``);
    expect(body).not.toContain("Verification result:");
    expect(isAutoscrubbedDependencyComment({ body })).toBe(true);
  });

  it("reads base lockfiles with the base API before writing autoscrub commits", async () => {
    const calls: Array<{ api: string; path: string; variables?: unknown }> = [];
    const baseApi = {
      request: async (requestPath: string) => {
        calls.push({ api: "base", path: requestPath });
        if (requestPath.includes("/compare/")) {
          return { base_commit: { sha: "base-sha" }, merge_base_commit: { sha: mergeBaseSha } };
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

    const autoscrubPullRequest = {
      user: { id: 1, login: "contributor", type: "User" },
      base: { ref: "main", sha: "base-sha" },
      head: { ref: "contributor/change", sha: headSha },
    };
    const guard = {
      owner: "openclaw",
      repo: "openclaw",
      pullRequest: autoscrubPullRequest,
      pullPath: "/repos/openclaw/openclaw/pulls/1",
      issuePath: "/repos/openclaw/openclaw/issues/1",
      commentMarker: "<!-- openclaw:dependency-graph-guard -->",
      approvalCommand: "/allow-dependencies-change",
      api: {
        request: async (requestPath: string) =>
          requestPath.endsWith("/permission") ? { role_name: "read" } : autoscrubPullRequest,
        paginate: async (requestPath: string) => {
          if (requestPath === "/repos/openclaw/openclaw/issues/1/comments") {
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
      `base:/repos/openclaw/openclaw/compare/base-sha...${headSha}?per_page=1&page=2`,
      `base:/repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=${mergeBaseSha}`,
      "write:graphql",
    ]);
    expect(calls[2]?.variables).toMatchObject({
      input: {
        branch: {
          repositoryNameWithOwner: "contributor/openclaw",
          branchName: "contributor/change",
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
    const cases: Array<{ method: string; phase: string; status?: number; code?: string }> = [
      { method: "GET", phase: "http", status: 500 },
      { method: "HEAD", phase: "http", status: 500 },
      { method: "GET", phase: "http", status: 503 },
      { method: "GET", phase: "connection", code: "ECONNRESET" },
      { method: "GET", phase: "connection", code: "EAI_AGAIN" },
      { method: "GET", phase: "connection", code: "ENOTFOUND" },
      { method: "HEAD", phase: "connection", code: "UND_ERR_SOCKET" },
      { method: "GET", phase: "body", code: "UND_ERR_SOCKET" },
      { method: "GET", phase: "body", code: "ECONNRESET" },
      { method: "GET", phase: "budget", code: "ECONNRESET" },
    ];
    for (const { method, phase, status, code } of cases) {
      const error = new TypeError("terminated", {
        cause: Object.assign(new Error(phase === "budget" ? "connection reset" : undefined), {
          code,
        }),
      });
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
        if (phase === "http") {
          return new Response("unicorn", { status, statusText: "Server Error" });
        }
        if (phase === "body") {
          return interruptedJsonResponse(error);
        }
        throw error;
      });
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
    const cases: Array<{
      method: string;
      phase: string;
      status?: number;
      code?: string;
      error?: Error;
      abort?: boolean;
      matchMessage?: boolean;
    }> = [
      { method: "POST", phase: "http", status: 500 },
      { method: "PATCH", phase: "http", status: 500 },
      { method: "DELETE", phase: "http", status: 500 },
      { method: "POST", phase: "http", status: 503 },
      { method: "POST", phase: "body", code: "UND_ERR_SOCKET", matchMessage: true },
      { method: "GET", phase: "invalid-json" },
      { method: "GET", phase: "body", error: new Error("unknown stream error") },
      ...["POST", "PATCH", "DELETE"].map((method) => ({
        method,
        phase: "connection",
        code: "ECONNRESET",
        matchMessage: true,
      })),
      { method: "GET", phase: "connection", error: new DOMException("aborted", "AbortError") },
      {
        method: "GET",
        phase: "connection",
        error: new TypeError("fetch failed", {
          cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }),
        }),
      },
      { method: "GET", phase: "connection", error: new TypeError("invalid request") },
      ...["GET", "POST"].flatMap((method) =>
        ["connection", "body"].map((phase) => ({
          method,
          phase,
          code: "ECONNRESET",
          abort: true,
        })),
      ),
    ];
    for (const {
      method,
      phase,
      status,
      code,
      error: suppliedError,
      abort,
      matchMessage,
    } of cases) {
      const controller = new AbortController();
      const error =
        suppliedError ??
        new TypeError(phase === "body" && !abort ? "terminated" : "fetch failed", {
          cause: Object.assign(
            new Error(abort || phase === "body" ? undefined : "connection reset"),
            { code },
          ),
        });
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (abort) {
          controller.abort(error);
        }
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
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>((resolve) => {
          markFetchStarted = resolve;
        });
        const backoff = phase.endsWith("-backoff");
        const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
          signal = init?.signal ?? undefined;
          markFetchStarted();
          if (phase === "fetch") {
            return await new Promise<Response>(() => {});
          }
          if (phase === "body") {
            return new Response(new ReadableStream({ start() {} }), {
              headers: { "content-type": "application/json" },
            });
          }
          const error = new TypeError("terminated", {
            cause: Object.assign(new Error(), { code: "ECONNRESET" }),
          });
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
        await fetchStarted;
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

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecurityReviewPolicy } from "../../scripts/github/security-review-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const headSha = "a".repeat(40);
const author = { id: 1, login: "contributor", type: "User" };
const approver = { id: 2, login: "maintainer", type: "User" };
const pullPath = "/repos/openclaw/openclaw/pulls/7";
const rolloutSha = "c".repeat(40);
const rollout = {
  number: 152415,
  state: "closed",
  merged: true,
  merged_at: "2025-12-01T00:00:00Z",
  merge_commit_sha: rolloutSha,
  base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
};
const marker = "<!-- openclaw:security-sensitive-guard -->";
const requestedAt = "2026-01-01T00:00:00Z";
const notice = {
  id: 4,
  user: { id: 3, login: "github-actions[bot]", type: "Bot" },
  created_at: requestedAt,
  updated_at: requestedAt,
  body: `${marker}\n<!-- openclaw:approval-request ${JSON.stringify({ head: headSha, base: "main" })} -->\nReview this revision.`,
};
const approval = {
  id: 11,
  user: approver,
  html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-11",
  body: "/allow-security-sensitive-change",
  created_at: "2026-01-01T00:01:00Z",
  updated_at: "2026-01-01T00:01:00Z",
};
const commentEvent = {
  action: "created",
  issue: { number: 7, pull_request: {} },
  comment: approval,
};
const { collectSecuritySensitiveChanges } = loadSecurityReviewPolicy();

type Options = {
  authorRole?: string;
  approverRole?: string;
  authorType?: string;
  reviews?: object[];
  files?: object[];
  comments?: object[];
  event?: object;
  routes?: Record<string, unknown>;
  changedFiles?: number;
  createdAt?: string;
  policy?: string;
  script?: "security-sensitive-guard" | "dependency-guard";
};

function runGuard(options: Options = {}) {
  const root = tempDirs.make("security-sensitive-guard-");
  const eventPath = path.join(root, "event.json");
  const logPath = path.join(root, "requests.jsonl");
  const fixturePath = path.join(root, "fixture.json");
  const files = options.files ?? [{ filename: "src/gateway/auth.ts", status: "modified" }];
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    created_at: options.createdAt ?? "2026-01-01T00:00:00Z",
    user: { ...author, type: options.authorType ?? "User" },
    changed_files: options.changedFiles ?? files.length,
    head: { sha: headSha, ref: "change", repo: { id: 2 } },
    base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
  };
  const routes = {
    [`GET ${pullPath}`]: pr,
    [`GET /repos/openclaw/openclaw/commits/${headSha}/statuses`]: [],
    "GET /repos/openclaw/openclaw/pulls/152415": rollout,
    [`GET ${pullPath}/files`]: files,
    [`GET ${pullPath}/reviews`]: options.reviews ?? [],
    "GET /repos/openclaw/openclaw/issues/7/comments": options.comments ?? [notice],
    "GET /repos/openclaw/openclaw/issues/7/labels": [],
    "GET /repos/openclaw/openclaw/collaborators/contributor/permission": {
      role_name: options.authorRole ?? "read",
    },
    "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": {
      role_name: options.approverRole ?? "maintain",
    },
    ...options.routes,
  };
  writeFileSync(eventPath, JSON.stringify(options.event ?? { pull_request: pr }));
  writeFileSync(fixturePath, JSON.stringify({ routes, logPath }));
  writeFileSync(logPath, "");
  const script = options.script ?? "security-sensitive-guard";
  let scriptPath = path.resolve(`scripts/github/${script}.mjs`);
  if (options.policy !== undefined) {
    // Exercise policy edits in a separate trusted checkout without modifying the
    // shared source tree or adding a production-only-for-tests policy override.
    for (const source of [
      "scripts/github/security-sensitive-guard.mjs",
      "scripts/github/dependency-guard.mjs",
      "scripts/github/security-review-policy.mjs",
      "scripts/github/security-review-rollout.mjs",
      "scripts/github/guard-review.mjs",
      "scripts/github/guard-shared.mjs",
      "scripts/lib/bounded-response.mjs",
    ]) {
      const target = path.join(root, source);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github/security-review-policy.yml"), options.policy);
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    scriptPath = realpathSync(path.join(root, `scripts/github/${script}.mjs`));
  }
  const result = spawnSync(
    process.execPath,
    ["--import", path.resolve("test/fixtures/github-guard-fetch.mjs"), scriptPath],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_TOKEN: "fixture-token",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "123",
        OPENCLAW_GUARD_TEST_FIXTURE: fixturePath,
      },
    },
  );
  const requests = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string;
          path: string;
          body?: { state?: string; context?: string; body?: string; labels?: string[] };
        },
    );
  return {
    ...result,
    requests,
    statuses: requests
      .filter((request) => request.path.includes("/statuses/"))
      .map((request) => request.body?.state),
    comment: requests.findLast(
      (request) =>
        (request.method === "POST" && request.path.endsWith("/comments")) ||
        (request.method === "PATCH" && request.path.includes("/issues/comments/")),
    )?.body?.body,
  };
}

describe("security-sensitive guard entry point", () => {
  it.each(["maintain", "admin"])("allows a %s author without extra approval", (authorRole) => {
    const result = runGuard({ authorRole });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses).toEqual(["failure", "success"]);
    expect(result.comment).toContain("informational");
  });

  it.each([
    { script: "security-sensitive-guard" as const, filename: "src/gateway/auth.ts" },
    { script: "dependency-guard" as const, filename: "pnpm-workspace.yaml" },
  ])("$script reports GitHub errors when notice writes are forbidden", ({ script, filename }) => {
    const result = runGuard({
      script,
      files: [{ filename }],
      authorRole: "maintain",
      comments: [],
      routes: {
        "POST /repos/openclaw/openclaw/issues/7/comments": { httpError: 403 },
        "POST /repos/openclaw/openclaw/issues/7/labels": { httpError: 403 },
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Skipping label .*Fixture API failure/u);
    expect(result.stderr).toMatch(/Skipping comment creation.*Fixture API failure/u);
  });

  it("does not transfer a maintainer author's exemption to a duplicate PR with the same head", () => {
    const duplicatePullRequest = {
      number: 8,
      state: "open",
      draft: false,
      created_at: "2026-01-01T00:00:00Z",
      user: author,
      changed_files: 1,
      head: { sha: headSha, ref: "duplicate", repo: { id: 2 } },
      base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
    };
    const result = runGuard({
      authorRole: "maintain",
      routes: {
        [`GET /repos/openclaw/openclaw/commits/${headSha}/statuses`]: [
          {
            context: "openclaw/ci-gate",
            description: "PR #8: Security review has not completed",
            creator: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
        "GET /repos/openclaw/openclaw/pulls/8": duplicatePullRequest,
      },
    });
    expect(result.status).toBe(1);
    expect(result.statuses).not.toContain("success");
    expect(result.statuses.at(-1)).toBe("failure");
  });

  it.each([
    { name: "an external author", options: {} },
    { name: "write access", options: { authorRole: "write" } },
    { name: "an admin bot", options: { authorRole: "admin", authorType: "Bot" } },
    {
      name: "a normal GitHub Approve review without the command",
      options: { reviews: [{ user: approver, state: "APPROVED", commit_id: headSha }] },
    },
    {
      name: "a write-only approver",
      options: { comments: [notice, approval], approverRole: "write" },
    },
    {
      name: "a bot command",
      options: { comments: [notice, { ...approval, user: { ...approver, type: "Bot" } }] },
    },
    {
      name: "a removed maintainer",
      options: {
        comments: [notice, approval],
        routes: {
          "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": { httpError: 404 },
        },
      },
    },
    { name: "a command before the first notice", options: { comments: [approval] } },
    {
      name: "a command simultaneous with the notice",
      options: {
        comments: [notice, { ...approval, created_at: requestedAt, updated_at: requestedAt }],
      },
    },
    {
      name: "an old comment edited to add the command",
      options: { comments: [notice, { ...approval, created_at: requestedAt }] },
    },
    {
      name: "an edited command",
      options: { comments: [notice, { ...approval, updated_at: "2026-01-01T00:02:00Z" }] },
    },
    {
      name: "a comment posted before a new revision's sticky notice update",
      options: { comments: [{ ...notice, updated_at: "2026-01-01T00:02:00Z" }, approval] },
    },
    {
      name: "a different guard's command",
      options: { comments: [notice, { ...approval, body: "/allow-dependencies-change" }] },
    },
    {
      name: "a quoted command",
      options: { comments: [notice, { ...approval, body: "> /allow-security-sensitive-change" }] },
    },
    {
      name: "a command inside a code block",
      options: {
        comments: [notice, { ...approval, body: "```\n/allow-security-sensitive-change\n```" }],
      },
    },
    {
      name: "an untrusted notice copied by the contributor",
      options: { comments: [{ ...notice, user: author }, approval] },
    },
    {
      name: "a malformed request record",
      options: {
        comments: [
          { ...notice, body: `${marker}\n<!-- openclaw:approval-request { -->` },
          approval,
        ],
      },
    },
    {
      name: "a future request timestamp",
      options: {
        comments: [
          {
            ...notice,
            body: `${marker}\n<!-- openclaw:approval-request ${JSON.stringify({ head: headSha, base: "main", requestedAt: "2026-01-02T00:00:00Z" })} -->`,
          },
          approval,
        ],
      },
    },
    {
      name: "a legacy authorized bot comment",
      options: {
        comments: [
          {
            ...notice,
            body: `${marker}\n### Security-sensitive change authorized\nApproved SHA: \`${headSha}\``,
          },
          approval,
        ],
      },
    },
  ])("requires a fresh command for $name", ({ options }) => {
    const result = runGuard(options);
    expect(result.status).toBe(1);
    expect(result.statuses).toEqual(["failure", "failure"]);
    expect(result.stderr).toContain("A maintainer must approve");
    expect(
      result.requests.some((request) => request.body?.labels?.includes("security-review-required")),
    ).toBe(true);
  });

  it.each(["maintain", "admin"])(
    "accepts a current-revision command from a %s user",
    (approverRole) => {
      const result = runGuard({ comments: [notice, approval], approverRole, event: commentEvent });
      expect(result.status, result.stderr).toBe(0);
      expect(result.statuses).toEqual(["failure", "success"]);
      expect(result.comment).toContain("- Maintainer: @maintainer");
      expect(result.comment).toContain(`- Approval comment: ${approval.html_url}`);
      expect(
        result.requests
          .filter((request) => request.path.includes("/statuses/"))
          .every((request) => request.path.endsWith(headSha)),
      ).toBe(true);
    },
  );

  it("accepts both commands in one comment", () => {
    const result = runGuard({
      comments: [notice, { ...approval, body: `${approval.body}\n/allow-dependencies-change` }],
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["created", "edited", "deleted"])(
    "uses the %s comment event only as a PR locator and rereads live command authority",
    (action) => {
      const result = runGuard({ event: { ...commentEvent, action } });
      expect(result.statuses).toEqual(["failure", "failure"]);
    },
  );

  it.each([
    { name: "head", oldRecord: { head: "c".repeat(40), base: "main" } },
    { name: "target branch", oldRecord: { head: headSha, base: "stable" } },
  ])("rejects a delayed or replayed command after the $name changes", ({ oldRecord }) => {
    const oldNotice = {
      ...notice,
      body: `${marker}\n<!-- openclaw:approval-request ${JSON.stringify({ ...oldRecord, requestedAt })} -->`,
    };
    const result = runGuard({ comments: [oldNotice, approval], event: commentEvent });
    expect(result.statuses).toEqual(["failure", "failure"]);
    expect(result.comment).toContain(JSON.stringify({ head: headSha, base: "main" }));
    expect(result.comment).not.toContain('"requestedAt"');
  });

  it("keeps an approval through notice updates and revokes it when the command disappears", () => {
    const first = runGuard({ comments: [] });
    expect(first.statuses.at(-1)).toBe("failure");
    const waiting = runGuard({ comments: [{ ...notice, body: first.comment }] });
    expect(waiting.statuses.at(-1)).toBe("failure");
    const updatedNotice = { ...notice, body: waiting.comment, updated_at: "2026-01-01T00:02:00Z" };
    const allowed = runGuard({ comments: [updatedNotice, approval] });
    expect(allowed.status, allowed.stderr).toBe(0);
    const approvedNotice = {
      ...updatedNotice,
      body: allowed.comment,
      updated_at: "2026-01-01T00:03:00Z",
    };
    const refreshed = runGuard({
      comments: [approvedNotice, approval],
      event: commentEvent,
    });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    const revoked = runGuard({
      comments: [approvedNotice],
      event: { ...commentEvent, action: "deleted" },
    });
    expect(revoked.statuses).toEqual(["failure", "failure"]);
  });

  it("ignores issue comments outside a PR", () => {
    const result = runGuard({ event: { ...commentEvent, issue: { number: 7 } } });
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([]);
  });

  it("rejects manual input-only events before making requests", () => {
    const result = runGuard({ event: { inputs: { pr_number: "7" } } });
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([]);
  });

  it("fails closed when role verification is unavailable", () => {
    const result = runGuard({
      routes: {
        "GET /repos/openclaw/openclaw/collaborators/contributor/permission": { httpError: 403 },
      },
    });
    expect(result.status).toBe(1);
    expect(result.statuses).toEqual(["failure"]);
  });

  it("refuses incomplete changed-file lists", () => {
    const result = runGuard({ changedFiles: 3001 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("complete changed-file list");
    expect(result.statuses).toEqual(["failure"]);
  });

  it("refuses success if the PR changes after approval is read", () => {
    const pr = {
      number: 7,
      state: "open",
      draft: false,
      created_at: "2026-01-01T00:00:00Z",
      user: author,
      changed_files: 1,
      head: { sha: headSha, ref: "change", repo: { id: 2 } },
      base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
    };
    const result = runGuard({
      comments: [notice, approval],
      routes: {
        [`GET ${pullPath}`]: {
          responses: [pr, pr, { ...pr, head: { ...pr.head, sha: "c".repeat(40) } }],
        },
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pull request changed");
    expect(result.statuses).toEqual(["failure"]);
  });

  it("leaves hard-tier approval to CODEOWNERS and ignores ordinary changes", () => {
    const result = runGuard({
      comments: [],
      files: [{ filename: "SECURITY.md" }, { filename: "src/utils.ts" }],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses).toEqual(["failure", "success"]);
    expect(result.comment).toBeUndefined();
  });

  describe.each(["security-sensitive-guard", "dependency-guard"] as const)(
    "%s rollout enforcement",
    (script) => {
      const files = [
        { filename: script === "dependency-guard" ? "pnpm-workspace.yaml" : "src/gateway/auth.ts" },
      ];

      it("does not publish approval or mutate an older PR that has not incorporated the rollout", () => {
        const result = runGuard({
          script,
          files,
          createdAt: "2025-11-01T00:00:00Z",
          routes: {
            [`GET /repos/openclaw/openclaw/compare/${rolloutSha}...${headSha}`]: {
              base_commit: { sha: rolloutSha },
              merge_base_commit: { sha: "b".repeat(40) },
              status: "diverged",
            },
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("grandfathered");
        expect(result.statuses).toEqual([]);
        expect(result.requests.every((request) => request.method === "GET")).toBe(true);
      });

      it("requires approval after an older PR incorporates the rollout", () => {
        const result = runGuard({
          script,
          files,
          createdAt: "2025-11-01T00:00:00Z",
          routes: {
            [`GET /repos/openclaw/openclaw/compare/${rolloutSha}...${headSha}`]: {
              base_commit: { sha: rolloutSha },
              merge_base_commit: { sha: rolloutSha },
              status: "ahead",
            },
          },
        });
        expect(result.status).toBe(1);
        expect(result.statuses.at(-1)).toBe("failure");
        expect(result.comment).toContain("/allow-");
      });

      it.each([
        { name: "unavailable", response: { httpError: 403 } },
        { name: "malformed", response: { ...rollout, merge_commit_sha: "main" } },
      ])("invalidates a previous approval when rollout metadata is $name", ({ response }) => {
        const result = runGuard({
          script,
          files,
          routes: { "GET /repos/openclaw/openclaw/pulls/152415": response },
        });
        expect(result.status).toBe(1);
        expect(result.statuses).toEqual(["failure"]);
      });
    },
  );

  describe("trusted YAML policy", () => {
    const policy = `
exclude: {}
categories:
  custom:
    description: Custom protected responsibility.
    review: Inspect this responsibility carefully.
    paths: ["custom/product.ts"]
dependencies:
  manifests: ["**/package.json"]
  lockfiles: ["**/pnpm-lock.yaml"]
  other: ["custom/dependency-policy"]
`;

    it.each([
      { script: "security-sensitive-guard" as const, filename: "custom/product.ts" },
      { script: "dependency-guard" as const, filename: "custom/dependency-policy" },
    ])(
      "$script reads changed classification from YAML beside its checkout",
      ({ script, filename }) => {
        const result = runGuard({ script, policy, files: [{ filename }] });
        expect(result.statuses).toEqual(["failure", "failure"]);
        expect(result.comment).toContain("custom/");
      },
    );

    it.each(["security-sensitive-guard", "dependency-guard"] as const)(
      "%s cannot preserve an old success when YAML is invalid",
      (script) => {
        for (const invalidPolicy of ["categories: [", policy.replace("paths:", "pathz:")]) {
          const result = runGuard({ script, policy: invalidPolicy });
          expect(result.status).toBe(1);
          expect(result.statuses).toEqual(["failure"]);
          expect(result.stderr).toContain("Invalid security-review-policy.yml");
        }
      },
    );
  });
});

describe("sensitive change classification", () => {
  it.each([
    "src/gateway/auth.ts",
    "src/gateway/operator-scopes.ts",
    "src/gateway/origin-check.ts",
    "src/gateway/server/ws-origin-policy.ts",
    "src/gateway/methods/core-method-policy.ts",
    "src/gateway/session-method-policy.ts",
    "src/shared/operator-scope-compat.ts",
    "src/shared/device-bootstrap-profile.ts",
    "src/shared/gateway-method-policy.ts",
    "src/shared/session-method-scopes.ts",
    "src/infra/device-bootstrap.ts",
    "src/agents/agent-tools.policy.ts",
    "src/gateway/server/ws-connection/message-handler.ts",
    "src/secrets/resolve.ts",
    "src/secrets/.hidden-store/key.ts",
    "src/gateway/.internal/auth.ts",
    "src/agents/auth-profiles/store.ts",
    "src/agents/sandbox/docker.ts",
    "src/infra/exec-approvals.ts",
    ".gitignore",
  ])("explains the security responsibility of %s", (filename) => {
    const changes = collectSecuritySensitiveChanges([{ filename }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: filename, reason: expect.any(String) });
    expect(changes[0]?.reason.length).toBeGreaterThan(40);
  });

  it("detects moving an owned file into an unclassified path without flagging tests or docs", () => {
    const changes = collectSecuritySensitiveChanges([
      { filename: "src/renamed.ts", previous_filename: "src/gateway/auth.ts" },
      { filename: "src/gateway/auth.test.ts" },
      { filename: "docs/gateway/authentication.md" },
    ]);
    expect(changes.map((change) => change.path)).toEqual(["src/gateway/auth.ts"]);
  });

  it("preserves exclusion boundaries and case sensitivity", () => {
    const changes = collectSecuritySensitiveChanges([
      "src/secrets/nested/TEST/store.ts",
      "src/secrets/store.MD",
      "src/secrets/store.test.ts",
      "src/secrets/nested-fixtures/store.ts",
      "src/secrets/store.TEST.ts",
      "src/secrets/fixtureless-store.ts",
    ]);
    expect(changes.map((change) => change.path)).toEqual([
      "src/secrets/fixtureless-store.ts",
      "src/secrets/store.TEST.ts",
    ]);
  });
});

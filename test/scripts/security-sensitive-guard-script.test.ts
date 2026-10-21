import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecurityReviewPolicy } from "../../scripts/github/security-review-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runGuardFixture, stageGuardPolicy } from "./security-review.test-support.js";

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
const requestNotice = (record: object) => ({
  ...notice,
  body: `${marker}\n<!-- openclaw:approval-request ${JSON.stringify(record)} -->`,
});
const approval = {
  id: 11,
  user: approver,
  html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-11",
  body: "/allow-security-sensitive-change",
  created_at: "2026-01-01T00:01:00Z",
  updated_at: "2026-01-01T00:01:00Z",
};
const command = (changes: Partial<typeof approval>): Options => ({
  comments: [notice, { ...approval, ...changes }],
});
const afterNotice = (changes: Partial<typeof notice>): Options => ({
  comments: [{ ...notice, ...changes }, approval],
});
const commentEvent = {
  action: "created",
  issue: { number: 7, pull_request: {} },
  comment: approval,
};
const { collectSecuritySensitiveChanges } = loadSecurityReviewPolicy();

const pullRequest = {
  number: 7,
  state: "open",
  draft: false,
  created_at: "2026-01-01T00:00:00Z",
  user: author,
  changed_files: 1,
  head: { sha: headSha, ref: "change", repo: { id: 2 } },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
};

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
  const files = options.files ?? [{ filename: "src/gateway/auth.ts", status: "modified" }];
  const pr = {
    ...pullRequest,
    created_at: options.createdAt ?? pullRequest.created_at,
    user: { ...author, type: options.authorType ?? "User" },
    changed_files: options.changedFiles ?? files.length,
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
  const script = options.script ?? "security-sensitive-guard";
  const scriptPath =
    options.policy === undefined
      ? path.resolve(`scripts/github/${script}.mjs`)
      : stageGuardPolicy(root, options.policy, script);
  const result = runGuardFixture({
    root,
    script: scriptPath,
    routes,
    event: { repository: { default_branch: "main" }, ...(options.event ?? { pull_request: pr }) },
    env: { PATH: process.env.PATH },
  });
  const { requests } = result;
  return {
    ...result,
    requests,
    statuses: requests
      .filter((request) => request.path?.includes("/statuses/"))
      .map((request) => request.body?.state),
    comment: requests.findLast(
      (request) =>
        (request.method === "POST" && request.path?.endsWith("/comments")) ||
        (request.method === "PATCH" && request.path?.includes("/issues/comments/")),
    )?.body?.body,
  };
}

function expectGuard(options: Options, statuses: string[], exitCode = 0) {
  const result = runGuard(options);
  expect(result.status, result.stderr).toBe(exitCode);
  expect(result.statuses).toEqual(statuses);
  return result;
}

describe("security-sensitive guard entry point", () => {
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
    expect(result.comment).toContain("informational");
    expect(result.stderr).toMatch(/Skipping label .*Fixture API failure/u);
    expect(result.stderr).toMatch(/Skipping comment creation.*Fixture API failure/u);
  });

  it.each<[string, Options]>([
    ["an external author", {}],
    ["an admin bot", { authorRole: "admin", authorType: "Bot" }],
    [
      "an ordinary approval review",
      { reviews: [{ user: approver, state: "APPROVED", commit_id: headSha }] },
    ],
    [
      "a removed maintainer",
      {
        ...command({}),
        routes: {
          "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": { httpError: 404 },
        },
      },
    ],
    ["a command before the first notice", { comments: [approval] }],
    ["a simultaneous command", command({ created_at: requestedAt, updated_at: requestedAt })],
    ["an old comment adding the command", command({ created_at: requestedAt })],
    ["a comment predating the revised notice", afterNotice({ updated_at: "2026-01-01T00:02:00Z" })],
    ["a quoted command", command({ body: "> /allow-security-sensitive-change" })],
    ["a fenced command", command({ body: "```\n/allow-security-sensitive-change\n```" })],
    ["a contributor's copied notice", afterNotice({ user: author })],
    [
      "a malformed request record",
      afterNotice({ body: `${marker}\n<!-- openclaw:approval-request { -->` }),
    ],
    [
      "a future request timestamp",
      afterNotice(
        requestNotice({ head: headSha, base: "main", requestedAt: "2026-01-02T00:00:00Z" }),
      ),
    ],
    [
      "a legacy authorized bot comment",
      afterNotice({
        body: `${marker}\n### Security-sensitive change authorized\nApproved SHA: \`${headSha}\``,
      }),
    ],
  ])("requires a fresh command for %s", (_name, options) => {
    const result = expectGuard(options, ["failure", "failure"]);
    expect(result.comment).toContain("/allow-security-sensitive-change");
    expect(
      result.requests.some((request) => request.body?.labels?.includes("security-review-required")),
    ).toBe(true);
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
    const oldNotice = requestNotice({ ...oldRecord, requestedAt });
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
    expect(allowed.statuses).toEqual(["failure", "success"]);
    expect(allowed.comment).toContain("- Maintainer: @maintainer");
    expect(allowed.comment).toContain(`- Approval comment: ${approval.html_url}`);
    expect(
      allowed.requests
        .filter(({ path: requestPath }) => requestPath.includes("/statuses/"))
        .every(({ path: requestPath }) => requestPath.endsWith(headSha)),
    ).toBe(true);
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
    expect(revoked.status, revoked.stderr).toBe(0);
    expect(revoked.statuses).toEqual(["failure", "failure"]);
  });

  it.each([{ ...commentEvent, issue: { number: 7 } }, { inputs: { pr_number: "7" } }])(
    "rejects events without a PR locator before making requests: %j",
    (event) => {
      const result = runGuard({ event });
      expect(result.status).toBe(1);
      expect(result.requests).toEqual([]);
    },
  );

  it.each([undefined, "", null])(
    "rejects an invalid default branch %s before writes",
    (defaultBranch) => {
      const result = runGuard({
        event: {
          repository: { default_branch: defaultBranch },
          issue: { number: 7, pull_request: {} },
          comment: {},
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("event has no default branch");
      expect(result.requests).toEqual([]);
    },
  );

  it.each(["security-sensitive-guard", "dependency-guard"] as const)(
    "%s stops a closed PR during rollout reads without publishing failure",
    (script) => {
      const pr = { ...pullRequest, created_at: "2025-01-01T00:00:00Z" };
      const result = runGuard({
        script,
        routes: {
          [`GET ${pullPath}`]: {
            responses: [
              { advanceMs: 15_000, response: pr },
              { ...pr, state: "closed" },
            ],
          },
          "GET /repos/openclaw/openclaw/pulls/152415": { advanceMs: 15_000, response: rollout },
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("skipping");
      expect(result.requests.every((entry) => entry.method === "GET")).toBe(true);
      expect(result.requests.at(-1)).toMatchObject({ method: "GET", path: pullPath });
    },
  );

  it("refuses incomplete changed-file lists", () => {
    const result = expectGuard({ changedFiles: 3001 }, ["failure"], 1);
    expect(result.stderr).toContain("complete changed-file list");
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

  it.each([
    { name: "unavailable", response: { httpError: 403 } },
    { name: "malformed", response: { ...rollout, merge_commit_sha: "main" } },
  ])("invalidates a previous approval when rollout metadata is $name", ({ response }) => {
    const result = runGuard({ routes: { "GET /repos/openclaw/openclaw/pulls/152415": response } });
    expect(result.status).toBe(1);
    expect(result.statuses).toEqual(["failure"]);
  });

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
  it.each<{
    files: Array<string | { filename: string; previous_filename?: string }>;
    expected: string[];
    explain?: boolean;
  }>([
    ...[
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
    ].map((filename) => ({ files: [{ filename }], expected: [filename], explain: true })),
    {
      files: [
        { filename: "src/renamed.ts", previous_filename: "src/gateway/auth.ts" },
        { filename: "src/gateway/auth.test.ts" },
        { filename: "docs/gateway/authentication.md" },
      ],
      expected: ["src/gateway/auth.ts"],
    },
    {
      files: [
        "src/secrets/nested/TEST/store.ts",
        "src/secrets/store.MD",
        "src/secrets/store.test.ts",
        "src/secrets/nested-fixtures/store.ts",
        "src/secrets/store.TEST.ts",
        "src/secrets/fixtureless-store.ts",
      ],
      expected: ["src/secrets/fixtureless-store.ts", "src/secrets/store.TEST.ts"],
    },
  ])(
    "classifies protected paths, renames, and exclusions: $files",
    ({ files, expected, explain }) => {
      const changes = collectSecuritySensitiveChanges(files);
      expect(changes.map((change) => change.path)).toEqual(expected);
      if (explain) {
        expect(changes[0]).toMatchObject({ path: expected[0], reason: expect.any(String) });
        expect(changes[0]?.reason.length).toBeGreaterThan(40);
      }
    },
  );
});

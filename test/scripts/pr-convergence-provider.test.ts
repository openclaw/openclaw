import { describe, expect, it } from "vitest";
import {
  createGhPrConvergenceProvider,
  resolveCurrentGitHubRepo,
} from "../../scripts/pr-convergence-provider.mjs";

const repo = "openclaw/openclaw";
const pr = 114095;
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function createGhFixture() {
  const calls: string[][] = [];
  const readGh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "repo") {
      return `${repo}\n`;
    }
    if (args[0] === "pr") {
      return JSON.stringify([
        { name: "CI", bucket: "pass", state: "SUCCESS", link: "https://example.test/ci" },
        {
          name: "Workflow Sanity",
          bucket: "pending",
          state: "PENDING",
          link: "https://example.test/sanity",
        },
      ]);
    }
    if (args[1] === "graphql") {
      if (args.some((arg) => arg.includes("reviewThreads"))) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PRRT_first",
                      isResolved: false,
                      comments: {
                        pageInfo: { hasNextPage: false },
                        nodes: [{ fullDatabaseId: "3" }],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (args.some((arg) => arg.includes("branchProtectionRule"))) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                baseRefName: "main",
                baseRef: { branchProtectionRule: null },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: pr,
              url: `https://github.com/${repo}/pull/${pr}`,
              headRefName: "feat/audit",
              headRefOid: headSha,
              baseRefName: "main",
              state: "OPEN",
              isDraft: false,
              title: "Audit PR convergence",
              lastEditedAt: "2026-08-10T00:00:00Z",
              titleEdits: { nodes: [{ createdAt: "2026-08-09T00:00:00Z" }] },
              baseEdits: { nodes: [{ createdAt: "2026-08-08T00:00:00Z" }] },
              author: { login: "pr-author" },
            },
          },
        },
      });
    }
    const endpoint = args.at(-1) ?? "";
    if (endpoint.includes("/check-runs?")) {
      return JSON.stringify([
        {
          check_runs: [
            {
              name: "CI",
              id: 10,
              html_url: "https://example.test/ci",
              details_url: "https://example.test/ci",
              status: "completed",
              conclusion: "success",
              completed_at: "2026-08-10T00:01:00Z",
              app: { id: 1 },
            },
            {
              name: "Workflow Sanity",
              id: 11,
              html_url: "https://example.test/sanity",
              details_url: "https://example.test/sanity",
              status: "in_progress",
              conclusion: null,
              started_at: "2026-08-10T00:02:00Z",
              app: { id: 1 },
            },
          ],
        },
      ]);
    }
    if (endpoint.includes("/statuses?")) {
      return JSON.stringify([[]]);
    }
    if (endpoint.includes("/rules/branches/")) {
      return JSON.stringify([
        [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "CI", integration_id: 1 },
                { context: "Workflow Sanity", integration_id: 1 },
              ],
            },
          },
        ],
      ]);
    }
    if (endpoint.includes("requested_reviewers")) {
      return JSON.stringify([{ users: [{ login: "alice" }], teams: [{ slug: "maintainer" }] }]);
    }
    if (endpoint.includes("/reviews?")) {
      return JSON.stringify([[{ id: 1 }], [{ id: 2 }]]);
    }
    if (endpoint.includes("/pulls/") && endpoint.includes("/comments?")) {
      return JSON.stringify([[{ id: 3 }]]);
    }
    if (endpoint.includes("/issues/") && endpoint.includes("/comments?")) {
      return JSON.stringify([[{ id: 4 }]]);
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  return { calls, readGh };
}

describe("GitHub PR convergence provider", () => {
  it("collects complete paginated review evidence and GraphQL PR edit metadata", async () => {
    const fixture = createGhFixture();
    const provider = createGhPrConvergenceProvider({ readGh: fixture.readGh });

    await expect(provider.fetchPullRequest({ repo, pr })).resolves.toEqual({
      number: pr,
      html_url: `https://github.com/${repo}/pull/${pr}`,
      head: { sha: headSha, ref: "feat/audit" },
      base: { ref: "main" },
      state: "OPEN",
      draft: false,
      title: "Audit PR convergence",
      last_edited_at: "2026-08-10T00:00:00Z",
      title_edited_at: "2026-08-09T00:00:00Z",
      base_edited_at: "2026-08-08T00:00:00Z",
      user: { login: "pr-author" },
    });
    await expect(provider.fetchFormalReviews({ repo, pr })).resolves.toEqual({
      items: [{ id: 1 }, { id: 2 }],
      complete: true,
    });
    await expect(provider.fetchInlineReviewComments({ repo, pr })).resolves.toEqual({
      items: [{ id: 3, thread_resolved: false }],
      complete: true,
    });
    await expect(provider.fetchIssueComments({ repo, pr })).resolves.toEqual({
      items: [{ id: 4 }],
      complete: true,
    });
    await expect(provider.fetchRequestedReviewers({ repo, pr })).resolves.toEqual({
      logins: ["alice", "maintainer"],
      complete: true,
    });
    expect(fixture.calls.filter((args) => args.includes("--paginate"))).toHaveLength(4);
  });

  it("paginates comments within a review thread before assigning resolution", async () => {
    const readGh = (args: string[]) => {
      if (args[1] !== "graphql") {
        if (args.at(-1)?.includes("/pulls/") && args.at(-1)?.includes("/comments?")) {
          return JSON.stringify([[{ id: "4294967297" }, { id: "4294967298" }]]);
        }
        throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
      }
      if (args.some((arg) => arg.includes("reviewThreads"))) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PRRT_paginated",
                      isResolved: true,
                      comments: {
                        pageInfo: { hasNextPage: true, endCursor: "comment-page-1" },
                        nodes: [{ fullDatabaseId: "4294967297" }],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (args.some((arg) => arg.includes("PullRequestReviewThread"))) {
        return JSON.stringify({
          data: {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ fullDatabaseId: "4294967298" }],
              },
            },
          },
        });
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchInlineReviewComments({ repo, pr })).resolves.toEqual({
      items: [
        { id: "4294967297", thread_resolved: true },
        { id: "4294967298", thread_resolved: true },
      ],
      complete: true,
    });
  });

  it("normalizes required checks while preserving pending status", async () => {
    const fixture = createGhFixture();
    const provider = createGhPrConvergenceProvider({ readGh: fixture.readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          required: true,
        }),
        expect.objectContaining({
          name: "Workflow Sanity",
          status: "in_progress",
          conclusion: null,
          head_sha: headSha,
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("reads pending required checks from the immutable exact-head endpoint", async () => {
    const readGh = (args: string[]) => {
      if (args[1] === "graphql") {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                baseRefName: "main",
                baseRef: { branchProtectionRule: null },
              },
            },
          },
        });
      }
      if (args.at(-1)?.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI" }] },
            },
          ],
        ]);
      }
      if (args.at(-1)?.includes("/check-runs?")) {
        return JSON.stringify([
          {
            check_runs: [
              {
                name: "CI",
                id: 100,
                status: "in_progress",
                conclusion: null,
                started_at: "2026-08-10T00:00:00Z",
                app: { id: 1 },
              },
            ],
          },
        ]);
      }
      if (args.at(-1)?.includes("/statuses?")) {
        return JSON.stringify([[]]);
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "CI",
          status: "in_progress",
          conclusion: null,
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("keeps policy-required checks pending when GitHub has not reported them", async () => {
    const readGh = (args: string[]) => {
      if (args[1] === "graphql") {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                baseRefName: "main",
                baseRef: { branchProtectionRule: null },
              },
            },
          },
        });
      }
      if (args.at(-1)?.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI" }] },
            },
          ],
        ]);
      }
      if (args.at(-1)?.includes("/check-runs?")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (args.at(-1)?.includes("/statuses?")) {
        return JSON.stringify([[]]);
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "CI",
          status: "queued",
          conclusion: null,
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("keeps an unstarted classic branch-protection check pending", async () => {
    const readGh = (args: string[]) => {
      if (args[1] === "graphql") {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                baseRefName: "main",
                baseRef: {
                  branchProtectionRule: {
                    requiresStatusChecks: true,
                    requiredStatusCheckContexts: ["Classic CI"],
                    requiredStatusChecks: [],
                  },
                },
              },
            },
          },
        });
      }
      if (args.at(-1)?.includes("/rules/branches/")) {
        return JSON.stringify([[]]);
      }
      if (args.at(-1)?.includes("/check-runs?")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (args.at(-1)?.includes("/statuses?")) {
        return JSON.stringify([[]]);
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "Classic CI",
          status: "queued",
          conclusion: null,
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("resolves an empty report only when the target branch policy is empty", async () => {
    const readGh = (args: string[]) => {
      if (args[1] === "graphql") {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                baseRefName: "main",
                baseRef: { branchProtectionRule: null },
              },
            },
          },
        });
      }
      if (args.at(-1)?.includes("/rules/branches/")) {
        return JSON.stringify([[]]);
      }
      if (args[0] === "pr") {
        throw Object.assign(new Error("no required checks"), {
          status: 1,
          stdout: "",
          stderr: "no required checks reported on the 'main' branch",
        });
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("maps a cancelled exact-head check to a failed terminal required check", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      if (args.at(-1)?.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "CI" }, { context: "Workflow Sanity" }],
              },
            },
          ],
        ]);
      }
      if (args.at(-1)?.includes("/check-runs?")) {
        return JSON.stringify([
          {
            check_runs: [
              {
                name: "CI",
                id: 101,
                status: "completed",
                conclusion: "cancelled",
                completed_at: "2026-08-10T00:01:00Z",
                app: { id: 1 },
              },
              {
                name: "Workflow Sanity",
                id: 102,
                status: "completed",
                conclusion: "success",
                completed_at: "2026-08-10T00:02:00Z",
                app: { id: 1 },
              },
            ],
          },
        ]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "CI",
          status: "completed",
          conclusion: "cancelled",
        }),
        expect.objectContaining({ name: "Workflow Sanity", conclusion: "success" }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("binds same-named check conclusions to each required app identity", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [
                  { context: "CI", integration_id: 1 },
                  { context: "CI", integration_id: 2 },
                ],
              },
            },
          ],
        ]);
      }
      if (endpoint.includes("/check-runs?")) {
        return JSON.stringify([
          {
            check_runs: [
              {
                name: "CI",
                id: 20,
                html_url: "https://example.test/ci",
                details_url: "https://example.test/ci",
                status: "completed",
                conclusion: "failure",
                completed_at: "2026-08-10T00:01:00Z",
                app: { id: 1 },
              },
              {
                name: "CI",
                id: 21,
                html_url: "https://example.test/ci",
                details_url: "https://example.test/ci",
                status: "completed",
                conclusion: "success",
                completed_at: "2026-08-10T00:02:00Z",
                app: { id: 2 },
              },
            ],
          },
        ]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({ name: "CI", conclusion: "failure", required: true }),
        expect.objectContaining({ name: "CI", conclusion: "success", required: true }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("retains independently required check-run and commit-status observations", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI" }] },
            },
          ],
        ]);
      }
      if (endpoint.includes("/check-runs?")) {
        return JSON.stringify([
          {
            check_runs: [
              {
                name: "CI",
                id: 40,
                status: "completed",
                conclusion: "failure",
                completed_at: "2026-08-10T00:01:00Z",
                app: { id: 1 },
              },
            ],
          },
        ]);
      }
      if (endpoint.includes("/statuses?")) {
        return JSON.stringify([
          [
            {
              id: 41,
              context: "CI",
              state: "success",
              updated_at: "2026-08-10T00:02:00Z",
              creator: { login: "ci-bot" },
            },
          ],
        ]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({ name: "CI", conclusion: "failure" }),
        expect.objectContaining({ name: "CI", conclusion: "success" }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("matches legacy commit-status contexts case-insensitively", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI" }] },
            },
          ],
        ]);
      }
      if (endpoint.includes("/check-runs?")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (endpoint.includes("/statuses?")) {
        return JSON.stringify([
          [
            {
              id: 50,
              context: "ci",
              state: "failure",
              updated_at: "2026-08-10T00:02:00Z",
              creator: { login: "ci-bot" },
            },
            {
              id: 51,
              context: "CI",
              state: "success",
              updated_at: "2026-08-10T00:01:00Z",
              creator: { login: "ci-bot" },
            },
          ],
        ]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [expect.objectContaining({ name: "CI", conclusion: "failure" })],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("uses newest-first API order for same-second legacy status updates", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI" }] },
            },
          ],
        ]);
      }
      if (endpoint.includes("/check-runs?")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (endpoint.includes("/statuses?")) {
        return JSON.stringify([
          [
            {
              id: 52,
              context: "CI",
              state: "success",
              updated_at: "2026-08-10T00:02:00Z",
              creator: { login: "ci-bot" },
            },
            {
              id: 53,
              context: "CI",
              state: "pending",
              updated_at: "2026-08-10T00:02:00Z",
              creator: { login: "ci-bot" },
            },
          ],
        ]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [expect.objectContaining({ name: "CI", conclusion: "success" })],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("resolves an app-bound legacy commit status by its GitHub App identity", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "Legacy CI", integration_id: 42 }],
              },
            },
          ],
        ]);
      }
      if (endpoint.includes("/check-runs?")) {
        return JSON.stringify([{ check_runs: [] }]);
      }
      if (endpoint.includes("/statuses?")) {
        return JSON.stringify([
          [
            {
              id: 30,
              context: "Legacy CI",
              state: "success",
              updated_at: "2026-08-10T00:03:00Z",
              target_url: "https://example.test/legacy",
              creator: { login: "legacy-ci[bot]" },
            },
          ],
        ]);
      }
      if (endpoint === "apps/legacy-ci") {
        return JSON.stringify({ id: 42, slug: "legacy-ci" });
      }
      if (args[0] === "pr") {
        return JSON.stringify([
          {
            name: "Legacy CI",
            bucket: "pass",
            state: "SUCCESS",
            link: "https://example.test/legacy",
          },
        ]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "Legacy CI",
          status: "completed",
          conclusion: "success",
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("does not resurrect an older app-bound success after an unexpected source posts", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint.includes("/rules/branches/")) {
        return JSON.stringify([
          [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "Legacy CI", integration_id: 42 }],
              },
            },
          ],
        ]);
      }
      if (endpoint.includes("/check-runs?")) {
        return JSON.stringify([
          {
            check_runs: [
              {
                name: "Legacy CI",
                id: 59,
                status: "completed",
                conclusion: "success",
                completed_at: "2026-08-10T00:05:00Z",
                app: { id: 42 },
              },
            ],
          },
        ]);
      }
      if (endpoint.includes("/statuses?")) {
        return JSON.stringify([
          [
            {
              id: 60,
              context: "Legacy CI",
              state: "pending",
              updated_at: "2026-08-10T00:04:00Z",
              creator: { login: "other-ci[bot]" },
            },
            {
              id: 61,
              context: "Legacy CI",
              state: "success",
              updated_at: "2026-08-10T00:03:00Z",
              creator: { login: "legacy-ci[bot]" },
            },
          ],
        ]);
      }
      if (endpoint === "apps/other-ci") {
        return JSON.stringify({ id: 99, slug: "other-ci" });
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "Legacy CI",
          status: "queued",
          conclusion: null,
        }),
        expect.objectContaining({
          name: "Legacy CI",
          status: "completed",
          conclusion: "success",
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("fails required-check policy closed when branch rules cannot be resolved", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      if (args.at(-1)?.includes("/rules/branches/")) {
        throw new Error("rules unavailable");
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: expect.any(Array),
      complete: true,
      requiredPolicy: "unknown",
    });
  });

  it("fails required-workflow rules closed when their complete context set is unavailable", async () => {
    const fixture = createGhFixture();
    const readGh = (args: string[]) => {
      if (args.at(-1)?.includes("/rules/branches/")) {
        return JSON.stringify([[{ type: "workflows", parameters: { workflows: [] } }]]);
      }
      return fixture.readGh(args);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: expect.any(Array),
      complete: true,
      requiredPolicy: "unknown",
    });
  });

  it("resolves the repository through the read-only gh seam", () => {
    const fixture = createGhFixture();
    expect(resolveCurrentGitHubRepo({ readGh: fixture.readGh })).toBe(repo);
    expect(fixture.calls[0]).toEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]);
  });
});

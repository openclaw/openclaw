import { isRecord as recordShapeMatches } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock("./github-public-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-public-api.js")>()),
  gitHubPublicApi: {
    GITHUB_API_BASE_URL: "https://api.microsoft.ghe.com",
    ControlUiGitHubError: class extends Error {
      constructor(
        readonly statusCode: number,
        message: string,
      ) {
        super(message);
      }
    },
    fetchGitHubApi: mocks.fetchApi,
    isRecord: recordShapeMatches,
    optionalNumber: (value: Record<string, unknown>, key: string) =>
      typeof value[key] === "number" ? value[key] : undefined,
    readGitHubJsonResponse: (response: Response) => response.json(),
    readOptionalGitHubString: (value: Record<string, unknown>, key: string) =>
      typeof value[key] === "string" && value[key] ? value[key] : undefined,
    requiredString: (value: Record<string, unknown>, key: string) => {
      const result = value[key];
      if (typeof result !== "string" || !result) {
        throw new Error(`missing ${key}`);
      }
      return result;
    },
  },
}));

import { readBoundGitHubPullRequest } from "./github-pull-request-read.js";

describe("bounded Gateway GitHub pull request reads", () => {
  it.each([false, true])(
    "returns bounded enterprise PR data, including deleted-fork heads: %s",
    async (deletedFork) => {
      mocks.fetchApi.mockClear();
      const token = "must-not-leave-the-gateway";
      mocks.fetchApi.mockImplementation(async (url: string) => {
        if (url.endsWith("/pulls/15913")) {
          return Response.json({
            html_url: "https://microsoft.ghe.com/bic/lobster/pull/15913",
            title: "Synthetic TeamClaw pull request",
            body: "b".repeat(30_000),
            state: "open",
            draft: false,
            user: { login: "contributor" },
            changed_files: 21,
            base: {
              label: "bic:main",
              ref: "main",
              sha: "base-sha",
              repo: { full_name: "bic/lobster" },
            },
            head: {
              label: "bic:feature",
              ref: "feature",
              sha: "head-sha",
              repo: deletedFork ? null : { full_name: "bic/lobster" },
            },
          });
        }
        if (url.includes("/files?")) {
          return Response.json(
            Array.from({ length: 20 }, (_, index) => ({
              filename: `src/file-${index}.ts`,
              status: "modified",
              additions: 2,
              deletions: 1,
              changes: 3,
              patch: "p".repeat(5_000),
            })),
          );
        }
        return Response.json(
          Array.from({ length: 21 }, (_, index) => ({
            user: { login: `reviewer-${index}` },
            state: "APPROVED",
            submitted_at: "2026-09-24T00:00:00Z",
            body: "r".repeat(3_000),
          })),
        );
      });
      const assertSelected = vi.fn();
      const result = await readBoundGitHubPullRequest({
        target: { owner: "bic", repo: "lobster", number: 15913 },
        identity: {
          token,
          cacheScope: "selected-principal",
          selection: { source: "agent-override", profileId: "app-user", accountId: 42 },
          assertSelected,
          revalidate: async () => assertSelected(),
          start: async <T>(operation: () => T): Promise<Awaited<T>> => await operation(),
        },
      });

      expect(mocks.fetchApi.mock.calls.map(([url]) => url)).toEqual([
        "https://api.microsoft.ghe.com/repos/bic/lobster/pulls/15913",
        "https://api.microsoft.ghe.com/repos/bic/lobster/pulls/15913/files?per_page=20",
        "https://api.microsoft.ghe.com/repos/bic/lobster/pulls/15913/reviews?per_page=21",
      ]);
      expect(mocks.fetchApi).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
        token,
        expect.any(Function),
        expect.objectContaining({ selection: expect.objectContaining({ accountId: 42 }) }),
      );
      expect(result).toMatchObject({
        content_trust: "untrusted_external_content",
        repository: "bic/lobster",
        number: 15913,
        title: "Synthetic TeamClaw pull request",
        author: "contributor",
        state: "open",
        base: { repository: "bic/lobster", ref: "main", sha: "base-sha" },
        head: {
          ...(deletedFork ? {} : { repository: "bic/lobster" }),
          ref: "feature",
          sha: "head-sha",
        },
        files_total: 21,
        files_truncated: true,
        reviews_truncated: true,
        issue_comments: {
          available: false,
          reason: expect.stringContaining("pull-request reads only"),
        },
      });
      expect(result.body).toHaveLength(24 * 1024);
      expect(result.files).toHaveLength(20);
      expect(result.files[0]?.patch).toHaveLength(4 * 1024);
      expect(result.reviews).toHaveLength(20);
      expect(result.reviews[0]?.body).toHaveLength(2 * 1024);
      expect(JSON.stringify(result)).not.toContain(token);
    },
  );
});

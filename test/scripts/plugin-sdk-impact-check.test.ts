// Plugin SDK Impact Check tests cover GitHub API helper behavior for the CI gate.
import { describe, expect, it, vi } from "vitest";
import { testing } from "../../scripts/github/plugin-sdk-impact-check.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("plugin-sdk-impact-check GitHub helpers", () => {
  it("fetches pull request metadata for issue-comment events", async () => {
    const fetch = vi.fn((url: URL | string) => {
      expect(String(url)).toBe("https://api.github.com/repos/openclaw/openclaw/pulls/123");
      return Promise.resolve(jsonResponse({ number: 123 }));
    });

    await expect(
      testing.fetchPullRequest({
        fetchImpl: fetch as typeof globalThis.fetch,
        owner: "openclaw",
        pullNumber: 123,
        repo: "openclaw",
        token: "tok",
      }),
    ).resolves.toEqual({ number: 123 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches all pull request file pages before classification", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/noise/${index}.ts`,
    }));
    const secondPage = [{ filename: "src/plugin-sdk/core.ts" }];
    const fetch = vi.fn((url: URL | string) => {
      const page = new URL(String(url)).searchParams.get("page");
      return Promise.resolve(jsonResponse(page === "1" ? firstPage : secondPage));
    });

    await expect(
      testing.fetchPullRequestFiles({
        fetchImpl: fetch as typeof globalThis.fetch,
        owner: "openclaw",
        pullNumber: 123,
        repo: "openclaw",
        token: "tok",
      }),
    ).resolves.toHaveLength(101);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires an active maintainer approval for the exact head SHA", async () => {
    const fetch = vi.fn((url: URL | string) => {
      const href = String(url);
      if (href.includes("/teams/maintainer/memberships/alice")) {
        return Promise.resolve(jsonResponse({ state: "active" }));
      }
      return Promise.resolve(jsonResponse({ state: "pending" }));
    });

    await expect(
      testing.hasMaintainerApprovalForHead({
        appToken: "app-token",
        fetchImpl: fetch as typeof globalThis.fetch,
        org: "openclaw",
        pullRequest: { head: { sha: HEAD_SHA } },
        reviews: [
          {
            commit_id: HEAD_SHA,
            state: "APPROVED",
            submitted_at: "2026-06-07T10:00:00Z",
            user: { login: "alice" },
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  it("ignores approvals for older commits", async () => {
    const fetch = vi.fn();

    await expect(
      testing.hasMaintainerApprovalForHead({
        appToken: "app-token",
        fetchImpl: fetch as typeof globalThis.fetch,
        org: "openclaw",
        pullRequest: { head: { sha: HEAD_SHA } },
        reviews: [
          {
            commit_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            state: "APPROVED",
            submitted_at: "2026-06-07T10:00:00Z",
            user: { login: "alice" },
          },
        ],
      }),
    ).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the latest review state per maintainer", async () => {
    const fetch = vi.fn();

    await expect(
      testing.hasMaintainerApprovalForHead({
        appToken: "app-token",
        fetchImpl: fetch as typeof globalThis.fetch,
        org: "openclaw",
        pullRequest: { head: { sha: HEAD_SHA } },
        reviews: [
          {
            commit_id: HEAD_SHA,
            state: "APPROVED",
            submitted_at: "2026-06-07T10:00:00Z",
            user: { login: "alice" },
          },
          {
            commit_id: HEAD_SHA,
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-06-07T11:00:00Z",
            user: { login: "alice" },
          },
        ],
      }),
    ).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let later comment-only reviews erase an exact-head approval", async () => {
    const fetch = vi.fn((url: URL | string) => {
      const href = String(url);
      if (href.includes("/teams/maintainer/memberships/alice")) {
        return Promise.resolve(jsonResponse({ state: "active" }));
      }
      return Promise.resolve(jsonResponse({ state: "pending" }));
    });

    await expect(
      testing.hasMaintainerApprovalForHead({
        appToken: "app-token",
        fetchImpl: fetch as typeof globalThis.fetch,
        org: "openclaw",
        pullRequest: { head: { sha: HEAD_SHA } },
        reviews: [
          {
            commit_id: HEAD_SHA,
            state: "APPROVED",
            submitted_at: "2026-06-07T10:00:00Z",
            user: { login: "alice" },
          },
          {
            commit_id: HEAD_SHA,
            state: "COMMENTED",
            submitted_at: "2026-06-07T11:00:00Z",
            user: { login: "alice" },
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  it("does not accept privileged reviewer association when app-token secrets are unavailable", async () => {
    const fetch = vi.fn();

    await expect(
      testing.hasMaintainerApprovalForHead({
        appToken: "",
        fetchImpl: fetch as typeof globalThis.fetch,
        org: "openclaw",
        pullRequest: { head: { sha: HEAD_SHA } },
        reviews: [
          {
            author_association: "MEMBER",
            commit_id: HEAD_SHA,
            state: "APPROVED",
            submitted_at: "2026-06-07T10:00:00Z",
            user: { login: "alice" },
          },
        ],
      }),
    ).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts merged openclaw/rfcs pull requests", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ merged_at: "2026-06-07T11:00:00Z" }));

    await expect(
      testing.hasMergedRfcPullRequest({
        fetchImpl: fetch as typeof globalThis.fetch,
        pullNumbers: [7],
        token: "tok",
      }),
    ).resolves.toBe(true);
  });

  it("rejects unmerged openclaw/rfcs pull requests", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ merged_at: null }));

    await expect(
      testing.hasMergedRfcPullRequest({
        fetchImpl: fetch as typeof globalThis.fetch,
        pullNumbers: [7],
        token: "tok",
      }),
    ).resolves.toBe(false);
  });
});

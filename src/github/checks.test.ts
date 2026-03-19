import { describe, expect, it } from "vitest";
import { loadGitHubChecks, parseGitHubRepo, resolveGitHubToken } from "./checks.js";

describe("github checks", () => {
  it("parses owner/repo inputs", () => {
    expect(parseGitHubRepo("openclaw/openclaw")).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      repository: "openclaw/openclaw",
    });
    expect(parseGitHubRepo("https://github.com/openclaw/openclaw.git")).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      repository: "openclaw/openclaw",
    });
  });

  it("prefers explicit token before env fallbacks", () => {
    expect(resolveGitHubToken("  abc123  ")).toBe("abc123");
  });

  it("loads and summarizes failing checks and statuses", async () => {
    const responses = [
      {
        total_count: 2,
        check_runs: [
          {
            id: 1,
            name: "CI / test",
            status: "completed",
            conclusion: "failure",
            details_url: "https://example.invalid/runs/1",
          },
          {
            id: 2,
            name: "CI / lint",
            status: "in_progress",
            conclusion: null,
            details_url: "https://example.invalid/runs/2",
          },
        ],
      },
      {
        state: "failure",
        sha: "abc123",
        statuses: [
          {
            id: 10,
            context: "deploy/preview",
            state: "pending",
            target_url: "https://example.invalid/status/10",
          },
        ],
      },
    ];
    const fetchCalls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      fetchCalls.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const body = responses.shift();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await loadGitHubChecks({
      repo: "openclaw/openclaw",
      ref: "main",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchCalls[0]).toContain("/repos/openclaw/openclaw/commits/main/check-runs");
    expect(fetchCalls[1]).toContain("/repos/openclaw/openclaw/commits/main/status");
    expect(result.overallState).toBe("failure");
    expect(result.summary).toMatchObject({ failing: 1, pending: 2, total: 3 });
    expect(result.failing).toEqual([
      {
        kind: "check_run",
        name: "CI / test",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://example.invalid/runs/1",
      },
    ]);
    expect(result.pending).toEqual([
      {
        kind: "check_run",
        name: "CI / lint",
        status: "in_progress",
        detailsUrl: "https://example.invalid/runs/2",
      },
      {
        kind: "status",
        context: "deploy/preview",
        state: "pending",
        description: undefined,
        targetUrl: "https://example.invalid/status/10",
      },
    ]);
  });

  it("returns no_data when a ref has no checks or statuses", async () => {
    const responses = [
      { total_count: 0, check_runs: [] },
      { state: "success", sha: "abc", statuses: [] },
    ];
    const fetchImpl = async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await loadGitHubChecks({
      repo: "openclaw/openclaw",
      ref: "main",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.overallState).toBe("no_data");
    expect(result.summary.total).toBe(0);
  });
});

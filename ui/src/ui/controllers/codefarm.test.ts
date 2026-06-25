// Control UI tests cover Code Farm controller behavior.
import { describe, expect, it, vi } from "vitest";
import {
  getCodefarmState,
  loadCodefarmJobs,
  loadCodefarmRepos,
  observeCodefarmJob,
  selectCodefarmRepo,
} from "./codefarm.ts";

function createClient(responses: Record<string, unknown>) {
  const request = vi.fn(async (method: string, _params: unknown) => responses[method]);
  return { request };
}

describe("codefarm controller", () => {
  it("loads active and recent repos through the first-class Code Farm gateway method", async () => {
    const host = {};
    const client = createClient({
      "codefarm.repos": {
        repos: [
          {
            repo: "/Users/me/agent-space",
            name: "agent-space",
            totalJobs: 2,
            activeJobs: 1,
            reviewJobs: 1,
            blockedJobs: 0,
            latestUpdatedAt: "2026-06-25T12:00:00.000Z",
            statuses: { running: 1, ready_for_review: 1 },
          },
        ],
      },
    });

    await loadCodefarmRepos({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("codefarm.repos", {});
    expect(getCodefarmState(host).repos).toEqual([
      expect.objectContaining({
        repo: "/Users/me/agent-space",
        activeJobs: 1,
        totalJobs: 2,
      }),
    ]);
    expect(getCodefarmState(host).selectedRepo).toBe("/Users/me/agent-space");
  });

  it("selects a repo and loads its jobs without requiring a manual path", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.repos = [
      {
        repo: "/Users/me/agent-space",
        name: "agent-space",
        totalJobs: 2,
        activeJobs: 1,
        reviewJobs: 1,
        blockedJobs: 0,
        statuses: { running: 1 },
      },
    ];
    const client = createClient({
      "codefarm.list": {
        jobs: [
          {
            id: "cf_20260625_001",
            status: "running",
            runtime: "codex-cli",
            cwd: "/Users/me/agent-space",
            taskIntent: "Run tests",
          },
        ],
      },
    });

    await selectCodefarmRepo({ host, client: client as never, repo: "/Users/me/agent-space" });

    expect(client.request).toHaveBeenCalledWith("codefarm.list", {
      repo: "/Users/me/agent-space",
    });
    expect(state.selectedRepo).toBe("/Users/me/agent-space");
    expect(state.jobs).toEqual([expect.objectContaining({ id: "cf_20260625_001" })]);
    expect(state.selectedJobId).toBe("cf_20260625_001");
  });

  it("observes the selected job through the first-class Code Farm observe method", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.selectedRepo = "/Users/me/agent-space";
    state.jobs = [{ id: "cf_20260625_001", status: "running" }];
    state.selectedJobId = "cf_20260625_001";
    const client = createClient({
      "codefarm.observe": {
        jobId: "cf_20260625_001",
        repo: "/Users/me/agent-space",
        status: "running",
        terminal: { source: "tmux", truncated: false, lines: ["worker booted"] },
        tmux: {
          available: true,
          enabled: true,
          session: "codefarm_agent-space-12345678",
          window: "cf_20260625_001",
          pane: "%1",
          attachCommand: "tmux attach -t codefarm_agent-space-12345678",
          note: null,
        },
      },
    });

    await observeCodefarmJob({
      host,
      client: client as never,
      repo: "/Users/me/agent-space",
      jobId: "cf_20260625_001",
      lines: 80,
    });

    expect(client.request).toHaveBeenCalledWith("codefarm.observe", {
      repo: "/Users/me/agent-space",
      jobId: "cf_20260625_001",
      lines: 80,
    });
    expect(state.observation).toMatchObject({
      jobId: "cf_20260625_001",
      terminal: { source: "tmux", lines: ["worker booted"] },
    });
  });

  it("loads jobs from the manual repo fallback when discovery misses a repo", async () => {
    const host = {};
    const state = getCodefarmState(host);
    state.repoInput = "/Users/me/manual-repo";
    const client = createClient({ "codefarm.list": { jobs: [] } });

    await loadCodefarmJobs({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("codefarm.list", {
      repo: "/Users/me/manual-repo",
    });
    expect(state.selectedRepo).toBe("/Users/me/manual-repo");
  });
});

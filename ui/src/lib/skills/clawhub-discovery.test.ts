// @vitest-environment node
import { describe, expect, it } from "vitest";
import { searchClawHub } from "./clawhub-search.ts";
import { loadClawHubDetail } from "./index.ts";
import { createDeferredRequestQueue, createState } from "./skills.test-support.ts";

describe("searchClawHub", () => {
  it("requests the discovery feed when the query is empty", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ results: [] });

    await expect(searchClawHub(state.client!, "   ")).resolves.toEqual([]);

    expect(request).toHaveBeenCalledWith(
      "skills.search",
      { query: undefined, limit: 20 },
      { signal: undefined },
    );
  });

  it("returns search results and forwards cancellation", async () => {
    const { state, request } = createState();
    const controller = new AbortController();
    request.mockResolvedValue({
      results: [
        {
          score: 0.95,
          registry: "https://clawhub.ai",
          slug: "github-new",
          displayName: "GitHub New",
          summary: "Fresh result",
          version: "2.0.0",
        },
      ],
    });

    await expect(searchClawHub(state.client!, "github", controller.signal)).resolves.toEqual([
      expect.objectContaining({ slug: "github-new" }),
    ]);
    expect(request).toHaveBeenCalledWith(
      "skills.search",
      { query: "github", limit: 20 },
      { signal: controller.signal },
    );
  });
});

describe("loadClawHubDetail", () => {
  it("ignores stale detail responses after slug changes", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const firstPending = loadClawHubDetail(state, "github");
    const secondPending = loadClawHubDetail(state, "gitlab");

    queue.resolveNext({
      skill: { slug: "github", displayName: "GitHub", createdAt: 1, updatedAt: 2 },
    });
    await firstPending;

    queue.resolveNext({
      skill: { slug: "gitlab", displayName: "GitLab", createdAt: 3, updatedAt: 4 },
    });
    await secondPending;

    expect(state.clawhubDetailLoading).toBe(false);
    expect(state.clawhubDetail?.skill?.slug).toBe("gitlab");
  });

  it("ignores a same-client detail response from an older connection epoch", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const pending = loadClawHubDetail(state, "github");
    state.connected = false;
    state.skillsAgentRevision++;
    state.clawhubDetailLoading = false;
    state.connected = true;
    queue.resolveNext({
      skill: { slug: "stale", displayName: "Stale", createdAt: 1, updatedAt: 2 },
    });
    await pending;

    expect(state.clawhubDetail).toBeNull();
    expect(state.clawhubDetailLoading).toBe(false);
  });
});

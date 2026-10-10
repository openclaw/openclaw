import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { searchRemoteProjects } from "./project-github-search.js";

function repository(fullName: string, updatedAt: string, description?: string) {
  const [owner, name] = fullName.split("/");
  return {
    id: fullName,
    name,
    full_name: fullName,
    private: false,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    description: description ?? null,
    default_branch: "main",
    updated_at: updatedAt,
  };
}

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("project GitHub search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
  });

  it.each([false, true])(
    "retains quota cooldown across repeated and different queries (authenticated=%s)",
    async (authenticated) => {
      const token = authenticated ? "synthetic-search-quota-token" : undefined;
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
        );
      const options = { env: {}, fetchImpl, token };
      const query = `quota-query-${token === undefined ? "anonymous" : "authenticated"}`;
      await expect(searchRemoteProjects(query, options)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 60_000,
      });
      const calls = fetchImpl.mock.calls.length;
      now += 1_000;
      await expect(searchRemoteProjects(query, options)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 59_000,
      });
      await expect(searchRemoteProjects(`${query}-other`, options)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 59_000,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
      now += 59_000;
      fetchImpl.mockImplementation(async () => json({ items: [] }));
      await expect(searchRemoteProjects(query, options)).resolves.toMatchObject({ projects: [] });
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
    },
  );

  it.each([302, 401])("rechecks reader authority before retrying HTTP %s", async (status) => {
    let current = true;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (requestUrl(input).includes("/user/repos")) {
        return json([]);
      }
      current = false;
      return new Response(null, {
        status,
        headers: { location: "https://api.github.com/search/repositories?q=redirected" },
      });
    });
    await expect(
      searchRemoteProjects(`authority-retry-${status}`, {
        token: "synthetic-retry-token",
        fetchImpl,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Search authority retired");
          }
        },
      }),
    ).rejects.toThrow("Search authority retired");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "keeps coalesced search independent of a retired first reader (remaining=%s)",
    async (remaining) => {
      const gate = createDeferredCore<Response>();
      const started = createDeferredCore();
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
        started.resolve();
        return await new Promise<Response>((resolve, reject) => {
          void gate.promise.then(resolve, reject);
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Fixture request aborted", { cause: signal.reason })),
            {
              once: true,
            },
          );
        });
      });
      const options = { env: {}, fetchImpl, now: 1000 };
      const query = `coalesced-retirement-${remaining}`;
      const first = searchRemoteProjects(query, { ...options, signal: firstAbort.signal });
      const rejected = expect(first).rejects.toThrow("First reader retired");
      await started.promise;
      const second = searchRemoteProjects(query, { ...options, signal: secondAbort.signal });
      const secondOutcome = remaining
        ? expect(second).resolves.toMatchObject({ projects: [{ fullName: "acme/shared-result" }] })
        : expect(second).rejects.toThrow("Second reader retired");
      firstAbort.abort(new Error("First reader retired"));
      if (!remaining) {
        secondAbort.abort(new Error("Second reader retired"));
      }
      gate.resolve(json({ items: [repository("acme/shared-result", "2026-09-01")] }));
      await Promise.all([rejected, secondOutcome]);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("separates native search results when the selected Enterprise host changes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [] }));
    const config = (host: string) => ({
      gateway: { github: { host, apiBaseUrl: `https://${host}/api/v3` } },
    });
    setRuntimeConfigSnapshot(config("a.ghe.example.test"));
    await searchRemoteProjects("same-query", { token: "native-token", fetchImpl, now: 1_000 });
    setRuntimeConfigSnapshot(config("b.ghe.example.test"));
    await searchRemoteProjects("same-query", { token: "native-token", fetchImpl, now: 1_000 });

    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url).split("/api/v3/")[0])).toEqual([
      "https://a.ghe.example.test",
      "https://a.ghe.example.test",
      "https://b.ghe.example.test",
      "https://b.ghe.example.test",
    ]);
  });

  it("returns anonymous public results with a typed missing-credential state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            ...repository("openclaw/openclaw", "2026-08-10T00:00:00Z", "  public project  "),
            html_url: "  https://github.com/openclaw/openclaw  ",
          },
        ],
      }),
    );

    const result = await searchRemoteProjects("anonymous-openclaw", {
      env: {},
      fetchImpl,
      now: 100,
    });

    expect(result).toMatchObject({
      credential: "missing",
      projects: [
        {
          fullName: "openclaw/openclaw",
          webUrl: "https://github.com/openclaw/openclaw",
          description: "public project",
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/search/repositories?");
  });

  it("prioritizes matching affiliated repositories and fills from global search", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json([
          repository("acme/matching-private", "2026-01-01T00:00:00Z", "configured-query"),
          repository("acme/unrelated", "2026-08-10T00:00:00Z"),
        ]),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            repository("acme/matching-private", "2026-08-11T00:00:00Z"),
            repository("public/configured-query", "2026-08-10T00:00:00Z"),
          ],
        }),
      );

    const result = await searchRemoteProjects("configured-query", {
      env: { GH_TOKEN: "test-github-token" },
      fetchImpl,
      now: 200,
    });

    expect(result).toEqual({
      credential: "configured",
      projects: [
        expect.objectContaining({ fullName: "acme/matching-private" }),
        expect.objectContaining({ fullName: "public/configured-query" }),
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/user/repos?");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer test-github-token",
    );
  });

  it("accepts an explicitly prepared native credential without ambient token state", async () => {
    const selected = repository("acme/private-repo", "2026-09-23T00:00:00Z");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/repos/acme/private-repo")) {
        return json(selected);
      }
      if (url.includes("/user/repos")) {
        return json([selected]);
      }
      return json({ items: [selected] });
    });

    const result = await searchRemoteProjects("acme/private-repo", {
      env: {},
      fetchImpl,
      now: 250,
      token: "prepared-native-token",
    });

    expect(result).toMatchObject({
      credential: "configured",
      projects: [{ fullName: "acme/private-repo", defaultBranch: "main" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer prepared-native-token");
    }
  });

  it("preserves GitHub best-match order for global results instead of re-sorting by recency", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        items: [
          repository("openclaw/best-match", "2020-01-01T00:00:00Z"),
          repository("someone/recently-pushed-fork", "2026-08-25T00:00:00Z"),
        ],
      }),
    );

    const result = await searchRemoteProjects("best-match", { env: {}, fetchImpl, now: 300 });

    expect(result.projects.map((project) => project.fullName)).toEqual([
      "openclaw/best-match",
      "someone/recently-pushed-fork",
    ]);
    const searchUrl = requestUrl(fetchImpl.mock.calls[0]?.[0]);
    expect(searchUrl).not.toContain("sort=");
  });

  it("resolves exact owner/name queries directly and ranks the repository first", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (requestUrl(input).includes("/repos/openclaw/openclaw")) {
        return json(repository("openclaw/openclaw", "2026-08-20T00:00:00Z"));
      }
      return json({
        items: [
          repository("someone/openclaw-tutorial", "2026-08-25T00:00:00Z"),
          repository("openclaw/openclaw", "2026-08-20T00:00:00Z"),
        ],
      });
    });

    const result = await searchRemoteProjects("openclaw/openclaw", {
      env: {},
      fetchImpl,
      now: 400,
    });

    expect(result.projects.map((project) => project.fullName)).toEqual([
      "openclaw/openclaw",
      "someone/openclaw-tutorial",
    ]);
    expect(fetchImpl.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      expect.stringContaining("/repos/openclaw/openclaw"),
      expect.stringContaining("/search/repositories?"),
    ]);
  });

  it("degrades to search results when the exact owner/name lookup misses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (requestUrl(input).includes("/repos/")) {
        return json({ message: "Not Found" }, 404);
      }
      return json({ items: [repository("acme/missing-exact", "2026-08-10T00:00:00Z")] });
    });

    const result = await searchRemoteProjects("acme/missing-exact-repo", {
      env: {},
      fetchImpl,
      now: 500,
    });

    expect(result.projects.map((project) => project.fullName)).toEqual(["acme/missing-exact"]);
  });

  it("degrades optional lanes to global results when their requests reject in transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/repos/") || url.includes("/user/repos")) {
        throw new TypeError("fetch failed");
      }
      return json({ items: [repository("acme/still-works", "2026-08-10T00:00:00Z")] });
    });

    const result = await searchRemoteProjects("acme/still-works", {
      env: { GH_TOKEN: "test-github-token" },
      fetchImpl,
      now: 600,
    });

    expect(result.projects.map((project) => project.fullName)).toEqual(["acme/still-works"]);
  });

  it("caches normalized queries for 60 seconds and refetches after expiry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({ items: [repository("acme/cache-query", "2026-08-10")] }),
      );
    const options = { env: {}, fetchImpl, now: 1_000 };

    const first = await searchRemoteProjects("Cache-Query", options);
    const cached = await searchRemoteProjects(" cache-query ", { ...options, now: 60_999 });
    const refreshed = await searchRemoteProjects("cache-query", { ...options, now: 61_001 });

    expect(cached).toBe(first);
    expect(refreshed).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached results after the GitHub token rotates", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return json({
        items: [
          repository(
            authorization === "Bearer github-token-a"
              ? "acme/token-rotation-a"
              : "acme/token-rotation-b",
            "2026-08-10T00:00:00Z",
          ),
        ],
      });
    });
    vi.stubEnv("GH_TOKEN", "github-token-a");
    vi.stubEnv("GITHUB_TOKEN", "");

    const first = await searchRemoteProjects("token-rotation", { fetchImpl, now: 70_000 });

    vi.stubEnv("GH_TOKEN", "github-token-b");
    const second = await searchRemoteProjects("token-rotation", { fetchImpl, now: 70_001 });

    expect(first.projects).toContainEqual(
      expect.objectContaining({ fullName: "acme/token-rotation-a" }),
    );
    expect(second.projects).toContainEqual(
      expect.objectContaining({ fullName: "acme/token-rotation-b" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

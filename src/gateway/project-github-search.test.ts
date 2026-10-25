import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { searchRemoteProjects } from "./project-github-search.js";

function repository(fullName: string, description?: string, updatedAt?: string) {
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
    ...(updatedAt ? { updated_at: updatedAt } : {}),
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

const page = (...items: ReturnType<typeof repository>[]) => json({ items });
const fetchReturning = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);
const projectNames = (result: Awaited<ReturnType<typeof searchRemoteProjects>>) =>
  result.projects.map((project) => project.fullName);
const search = (query: string, fetchImpl: typeof fetch) =>
  searchRemoteProjects(query, { env: {}, fetchImpl });

function trackedTasks() {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    trackExecution: <T>(run: () => Promise<T>) => {
      const task = run();
      tasks.push(task);
      return task;
    },
  };
}

const affiliatedRequest = ([input]: Parameters<typeof fetch>) =>
  new URL(requestUrl(input)).pathname === "/user/repos";

function clock() {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return (value: number) => {
    now = value;
  };
}

function deferredFetch() {
  const gate = createDeferredCore<Response>();
  const started = createDeferredCore();
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    started.resolve();
    return new Promise<Response>((resolve, reject) => {
      void gate.promise.then(resolve, reject);
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(new Error("Fixture request aborted", { cause: signal.reason })),
        { once: true },
      );
    });
  });
  return { gate, started, fetchImpl };
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
      const setTime = clock();
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      );
      const options = { env: {}, fetchImpl, token };
      const query = `quota-query-${token === undefined ? "anonymous" : "authenticated"}`;
      await expect(searchRemoteProjects(query, options)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 60_000,
      });
      const calls = fetchImpl.mock.calls.length;
      setTime(2_000);
      await expect(searchRemoteProjects(query, options)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 59_000,
      });
      await expect(searchRemoteProjects(`${query}-other`, options)).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: 59_000,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
      setTime(61_000);
      fetchImpl.mockImplementation(async () => json({ items: [] }));
      await expect(searchRemoteProjects(query, options)).resolves.toMatchObject({ projects: [] });
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
    },
  );

  it.each([302, 401])("rechecks requester authority before retrying HTTP %s", async (status) => {
    let current = true;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
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
      const { gate, started, fetchImpl } = deferredFetch();
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();
      const options = { env: {}, fetchImpl };
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
      gate.resolve(page(repository("acme/shared-result")));
      await Promise.all([rejected, secondOutcome]);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("separates native search results when the selected Enterprise host changes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => page());
    const config = (host: string) => ({
      gateway: { github: { host, apiBaseUrl: `https://${host}/api/v3` } },
    });
    setRuntimeConfigSnapshot(config("a.ghe.example.test"));
    await searchRemoteProjects("same-query", { token: "native-token", fetchImpl });
    setRuntimeConfigSnapshot(config("b.ghe.example.test"));
    await searchRemoteProjects("same-query", { token: "native-token", fetchImpl });

    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url).split("/api/v3/")[0])).toEqual([
      "https://a.ghe.example.test",
      "https://a.ghe.example.test",
      "https://b.ghe.example.test",
      "https://b.ghe.example.test",
    ]);
  });

  it("keeps another query available when the shared affiliated page's initiating caller retires", async () => {
    const gate = createDeferredCore<Response>();
    const started = createDeferredCore();
    const firstAbort = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (new URL(requestUrl(input)).pathname === "/user/repos") {
        started.resolve();
        return gate.promise;
      }
      return page(repository("acme/public-project"));
    });
    const options = { token: "synthetic-shared-retirement-token", fetchImpl };
    const first = searchRemoteProjects("first", {
      ...options,
      signal: firstAbort.signal,
      assertCurrent: () => firstAbort.signal.throwIfAborted(),
    });
    const rejected = expect(first).rejects.toThrow("First query retired");
    await started.promise;
    const second = searchRemoteProjects("second", { ...options, assertCurrent: () => {} });
    firstAbort.abort(new Error("First query retired"));
    gate.resolve(json([]));
    await rejected;
    await expect(second).resolves.toMatchObject({
      projects: [{ fullName: "acme/public-project" }],
    });
    expect(fetchImpl.mock.calls.filter(affiliatedRequest)).toHaveLength(1);
  });

  it("returns normalized anonymous results in GitHub best-match order", async () => {
    const fetchImpl = fetchReturning(
      page(
        {
          ...repository("openclaw/openclaw", "  public project  ", "2020-01-01T00:00:00Z"),
          html_url: "  https://github.com/openclaw/openclaw  ",
        },
        repository("someone/recently-pushed-fork", undefined, "2026-08-25T00:00:00Z"),
      ),
    );

    const result = await search("anonymous-openclaw", fetchImpl);

    expect(result).toMatchObject({
      credential: "missing",
      projects: [
        {
          fullName: "openclaw/openclaw",
          webUrl: "https://github.com/openclaw/openclaw",
          description: "public project",
        },
        { fullName: "someone/recently-pushed-fork" },
      ],
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/search/repositories?");
    expect(requestUrl(fetchImpl.mock.calls[0]?.[0])).not.toContain("sort=");
  });

  it.each([false, true])(
    "ranks and deduplicates affiliations with native credentials=%s",
    async (native) => {
      const token = "synthetic-token";
      const query = native ? "acme/private-repo" : "configured-query";
      const selected = repository(native ? query : "acme/matching-private", query);
      const global = repository("public/configured-query");
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const path = new URL(requestUrl(input)).pathname;
        if (path === `/repos/${query}`) {
          return json(selected);
        }
        if (path === "/user/repos") {
          return json([selected, repository("acme/unrelated")]);
        }
        expect(path).toBe("/search/repositories");
        return page(global, selected);
      });
      const result = await searchRemoteProjects(query, {
        env: native ? {} : { GH_TOKEN: token },
        token: native ? token : undefined,
        fetchImpl,
      });
      expect(result.credential).toBe("configured");
      expect(projectNames(result)).toEqual([selected.full_name, global.full_name]);
      expect(result.projects[0]?.defaultBranch).toBe("main");
      expect(fetchImpl).toHaveBeenCalledTimes(native ? 3 : 2);
      for (const [, init] of fetchImpl.mock.calls) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      }
    },
  );

  it("shares affiliated pages across queries, conditionally refreshes, and isolates credentials", async () => {
    const setTime = clock();
    const { tasks, trackExecution } = trackedTasks();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(requestUrl(input));
      const headers = new Headers(init?.headers);
      if (headers.has("if-none-match")) {
        return new Response(null, { status: 304 });
      }
      const data =
        url.pathname === "/user/repos" ? [repository("acme/shared-project")] : { items: [] };
      return new Response(JSON.stringify(data), { headers: { etag: '"page-v1"' } });
    });
    const options = {
      token: "synthetic-shared-project-token",
      fetchImpl,
      trackExecution,
    };
    const results = await Promise.all(
      ["shared", "project"].map((query) => searchRemoteProjects(query, options)),
    );
    expect(results.map(projectNames)).toEqual([["acme/shared-project"], ["acme/shared-project"]]);
    const affiliatedCalls = () => fetchImpl.mock.calls.filter(affiliatedRequest);
    expect(affiliatedCalls()).toHaveLength(1);
    setTime(61_001);
    expect(await searchRemoteProjects("shared", options)).toMatchObject({ stale: true });
    await Promise.all(tasks);
    expect(await searchRemoteProjects("shared", options)).toEqual(results[0]);
    expect(affiliatedCalls()).toHaveLength(2);
    expect(new Headers(affiliatedCalls()[1]?.[1]?.headers).get("if-none-match")).toBe('"page-v1"');
    await searchRemoteProjects("shared", { ...options, token: "synthetic-other-project-token" });
    expect(affiliatedCalls()).toHaveLength(3);
    expect(new Headers(affiliatedCalls()[2]?.[1]?.headers).has("if-none-match")).toBe(false);
  });

  it.each([
    [
      "hit",
      "openclaw/openclaw",
      ["someone/openclaw-tutorial", "openclaw/openclaw"],
      ["openclaw/openclaw", "someone/openclaw-tutorial"],
    ],
    ["miss", "acme/missing-exact-repo", ["acme/missing-exact"], ["acme/missing-exact"]],
  ] as const)(
    "ranks exact owner/name lookup %s before global results",
    async (outcome, query, global, expected) => {
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (requestUrl(input).includes("/repos/")) {
          return outcome === "hit" ? json(repository(query)) : json({ message: "Not Found" }, 404);
        }
        return page(...global.map((name) => repository(name)));
      });
      expect(projectNames(await search(query, fetchImpl))).toEqual(expected);
      expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input))).toEqual([
        expect.stringContaining(`/repos/${query}`),
        expect.stringContaining("/search/repositories?"),
      ]);
    },
  );

  it("degrades optional lanes to global results when their requests reject in transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/repos/") || url.includes("/user/repos")) {
        throw new TypeError("fetch failed");
      }
      return page(repository("acme/still-works"));
    });

    const options = { env: { GH_TOKEN: "test-github-token" }, fetchImpl };
    const result = await searchRemoteProjects("acme/still-works", options);

    expect(projectNames(result)).toEqual(["acme/still-works"]);
    expect(await searchRemoteProjects("acme/still-works", options)).toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns marked stale normalized results while one refresh runs, then publishes fresh results", async ({
    signal,
  }) => {
    const setTime = clock();
    const gate = createDeferredCore<Response>();
    const { tasks: refreshes, trackExecution } = trackedTasks();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(repository("acme/cache-query")))
      .mockImplementation(() => gate.promise);
    const options = {
      env: {},
      fetchImpl,
      trackExecution,
    };
    const first = await searchRemoteProjects("Cache-Query", options);
    setTime(60_999);
    expect(await searchRemoteProjects(" cache-query ", options)).toEqual(first);
    setTime(61_001);
    try {
      const stale = await withinTest(searchRemoteProjects("cache-query", options), signal);
      expect(stale).toEqual({ ...first, stale: true });
      expect(await searchRemoteProjects("cache-query", options)).toEqual(stale);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await expect(
        searchRemoteProjects("cache-query", {
          ...options,
          assertCurrent: () => {
            throw new Error("Search authority retired");
          },
        }),
      ).rejects.toThrow("Search authority retired");
    } finally {
      gate.resolve(page(repository("acme/refreshed-query")));
      await Promise.all(refreshes);
    }
    expect(await searchRemoteProjects("cache-query", options)).toMatchObject({
      projects: [{ fullName: "acme/refreshed-query" }],
    });
    expect((await searchRemoteProjects("cache-query", options)).stale).toBeUndefined();
  });

  it("does not reuse cached results after the GitHub token rotates", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return page(
        repository(
          authorization === "Bearer github-token-a"
            ? "acme/token-rotation-a"
            : "acme/token-rotation-b",
        ),
      );
    });
    vi.stubEnv("GH_TOKEN", "github-token-a");
    vi.stubEnv("GITHUB_TOKEN", "");

    const first = await searchRemoteProjects("token-rotation", { fetchImpl });

    vi.stubEnv("GH_TOKEN", "github-token-b");
    const second = await searchRemoteProjects("token-rotation", { fetchImpl });

    expect([first, second].map(projectNames)).toEqual([
      ["acme/token-rotation-a"],
      ["acme/token-rotation-b"],
    ]);
  });
});

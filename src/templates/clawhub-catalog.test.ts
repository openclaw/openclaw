import { afterEach, describe, expect, it, vi } from "vitest";
import { searchClawHubTemplates } from "./clawhub-catalog.js";

const baseUrl = "https://registry.example";
const item = (name: string, installs = 1) => ({
  name,
  displayName: name,
  family: "template",
  channel: "community",
  ownerHandle: "alice",
  isOfficial: false,
  updatedAt: 1,
  stats: { installs },
});
afterEach(() => vi.unstubAllGlobals());

describe("public Template result continuations", () => {
  it.each([
    { query: "  @alice/starter  " },
    { category: "research" },
    { query: "research", category: "research" },
  ])("preserves the registry's ranked order and continuation for %j", async (filters) => {
    const firstItems = filters.category
      ? [item("popular", 100), item("@alice/starter", 1)]
      : [item("@alice/starter", 1), item("popular", 100)];
    const upstream = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/api/v1/templates/catalog-page");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const secondPage = url.searchParams.has("cursor");
      return Response.json({
        items: secondPage ? [item("third"), { ...item("hidden"), channel: "private" }] : firstItems,
        nextCursor: secondPage ? null : "registry:2+/=",
      });
    });
    vi.stubGlobal("fetch", upstream);
    const params = { baseUrl, ...filters, token: "synthetic-test-token" };
    const first = await searchClawHubTemplates(params);
    expect(first.entries.map((entry) => entry.packageName)).toEqual(
      filters.category ? ["popular", "@alice/starter"] : ["@alice/starter", "popular"],
    );
    expect(first.nextCursor).toBe("registry:2+/=");
    const second = await searchClawHubTemplates({ ...params, cursor: first.nextCursor! });
    expect(second.entries.map((entry) => entry.packageName)).toEqual(["third"]);
    expect(second.nextCursor).toBeNull();
    const search = {
      limit: "20",
      ...(filters.query && { q: filters.query.trim() }),
      ...(filters.category && { category: filters.category }),
    };
    expect(
      upstream.mock.calls.map(([url]) => Object.fromEntries(new URL(url).searchParams)),
    ).toEqual([search, { ...search, cursor: "registry:2+/=" }]);
  });
  it.each([
    { status: 400, cursor: "invalid", body: {} },
    { status: 403, cursor: undefined, body: {} },
    { status: 404, cursor: "issued-before-rollback", body: {} },
    { status: 200, cursor: undefined, body: { results: [] } },
    { status: 200, cursor: "loop", body: { items: [], nextCursor: "loop" } },
    { status: 200, cursor: undefined, body: { items: [], nextCursor: "template-page:collision" } },
  ])(
    "never restarts a failed or malformed ranked page ($status, $cursor)",
    async ({ status, cursor, body }) => {
      const upstream = vi.fn(async () => Response.json(body, { status }));
      vi.stubGlobal("fetch", upstream);
      await expect(searchClawHubTemplates({ baseUrl, query: "brief", cursor })).rejects.toThrow();
      expect(upstream).toHaveBeenCalledOnce();
    },
  );
  it("ranks the complete legacy category before slicing each page", async () => {
    const upstream = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/templates/catalog-page") {
        return new Response(null, { status: 404 });
      }
      expect(url.searchParams.get("category")).toBe("research");
      const next = url.searchParams.get("cursor");
      return Response.json(
        next === "registry-next"
          ? { items: [item("popular", 20)], nextCursor: null }
          : { items: [item("newest")], nextCursor: "registry-next" },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const params = { category: "research", limit: 1, baseUrl };
    const first = await searchClawHubTemplates(params);
    const second = await searchClawHubTemplates({ ...params, cursor: first.nextCursor! });
    expect(first.entries.map((x) => x.packageName)).toEqual(["popular"]);
    expect(second.entries.map((x) => x.packageName)).toEqual(["newest"]);
    expect(second.nextCursor).toBeUndefined();
    expect(upstream.mock.calls.map(([url]) => new URL(url).searchParams.get("cursor"))).toEqual([
      null, // Missing ranked first page; no second probe with a legacy cursor.
      null,
      "registry-next",
      null,
      "registry-next",
    ]);
  });
  it("passes through an opaque flat directory cursor even if it resembles a legacy projection", async () => {
    const opaque = 'template-page:["opaque","",1]:1';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        expect(url.pathname).toBe("/api/v1/packages");
        return Response.json(
          url.searchParams.get("cursor") === opaque
            ? { items: [item("second")], nextCursor: null }
            : { items: [item("first")], nextCursor: opaque },
        );
      }),
    );
    const first = await searchClawHubTemplates({ baseUrl, limit: 1 });
    expect(first.nextCursor).toBe(opaque);
    const second = await searchClawHubTemplates({ baseUrl, limit: 1, cursor: first.nextCursor! });
    expect(second.entries.map((entry) => entry.packageName)).toEqual(["second"]);
    expect(second.nextCursor).toBeNull();
  });
  it("fills a featured shelf past an ineligible publisher without changing its order", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      urls.push(url);
      return Response.json(
        url.searchParams.has("cursor")
          ? { items: [item("third")], nextCursor: "next" }
          : {
              items: [{ ...item("hidden"), channel: "private" }, item("second")],
              nextCursor: "more",
            },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const page = await searchClawHubTemplates({ featured: true, limit: 2, baseUrl });
    expect(page.entries.map((x) => x.packageName)).toEqual(["second", "third"]);
    expect(page.nextCursor).toBe("next");
    expect(urls.map((u) => [u.searchParams.get("limit"), u.searchParams.get("cursor")])).toEqual([
      ["2", null],
      ["1", "more"],
    ]);
  });
  it("preserves typed matches across pages when a smaller upstream window has a different ranking", async () => {
    const hits = Array.from({ length: 46 }, (_, i) => ({
      score: 100 - i,
      package: item("match-" + i),
    }));
    const upstream = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/templates/catalog-page") {
        return new Response(null, { status: 404 });
      }
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({ results: limit < 100 ? hits.slice(1, limit + 1) : hits });
    });
    vi.stubGlobal("fetch", upstream);
    const params = { query: "match", baseUrl };
    const first = await searchClawHubTemplates(params);
    const second = await searchClawHubTemplates({ ...params, cursor: first.nextCursor! });
    const third = await searchClawHubTemplates({ ...params, cursor: second.nextCursor! });
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([
      20, 20, 6,
    ]);
    expect(
      [...first.entries, ...second.entries, ...third.entries].map((x) => x.packageName),
    ).toEqual(hits.map((x) => x.package.name));
    expect(third.nextCursor).toBeUndefined();
    await expect(
      searchClawHubTemplates({ ...params, query: "different", cursor: first.nextCursor! }),
    ).rejects.toThrow(/cursor/);
    expect(upstream.mock.calls.map(([input]) => new URL(input).searchParams.get("limit"))).toEqual([
      "20",
      "100",
      "100",
      "100",
    ]);
  });
});

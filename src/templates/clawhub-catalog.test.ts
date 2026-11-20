import { afterEach, describe, expect, it, vi } from "vitest";
import { readClawHubTemplatesOverview, searchClawHubTemplates } from "./clawhub-catalog.js";
import {
  officialPackage,
  communityPackage,
  packageName,
  personalPackageName,
} from "./clawhub-catalog.test-support.js";

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

describe("public Template overview certification", () => {
  it.each([
    { optIn: undefined, marker: true }, // A plain overview ignores an unsolicited certificate.
    { optIn: false, marker: true },
    { optIn: true, marker: undefined }, // Legacy or over-budget registry: only shelves are known.
    { optIn: true, marker: "true" },
  ])(
    "keeps the bounded overview when optIn=$optIn and marker=$marker",
    async ({ optIn, marker }) => {
      const official = { ...officialPackage(), stats: { installs: 20 } };
      const community = { ...communityPackage(), stats: { installs: 1 } };
      const impostor = officialPackage("@other/impostor");
      const extra = officialPackage("@openclaw/extra");
      const items = [community, impostor, official, extra];
      const fetch = vi.fn(async (_input: unknown) =>
        Response.json({
          complete: true,
          completeCategoryEntries: marker,
          featured: items,
          sections: [{ category: "research", items }],
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const overview = await readClawHubTemplatesOverview({
        baseUrl: "https://registry.example",
        limit: 2,
        timeoutMs: 1234,
        ...(optIn === undefined ? {} : { includeCategoryEntries: optIn }),
      });
      expect(overview?.featured.map((entry) => entry.packageName)).toEqual([
        personalPackageName,
        packageName,
      ]);
      expect(overview?.sections[0]?.entries.map((entry) => entry.packageName)).toEqual([
        packageName,
        personalPackageName,
      ]);
      expect(overview?.sections[0]).not.toHaveProperty("additionalEntries");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toBe(
        "https://registry.example/api/v1/templates/overview?limit=2" +
          (optIn ? "&include=categoryEntries" : ""),
      );
    },
  );

  it("splits each certified category after filtering, last-valid de-duplication and ranking", async () => {
    const older = { ...officialPackage(), stats: { installs: 100 } };
    const current = { ...older, displayName: "Current release", stats: { installs: 7 } };
    const community = { ...communityPackage(), stats: { installs: 20 } };
    const tie = { ...officialPackage("@openclaw/zebra"), stats: { installs: 7 } };
    const items = [older, tie, community, current, { ...older, ownerHandle: "impostor" }];
    const fetch = vi.fn(async (_input: unknown) =>
      Response.json({
        complete: true,
        completeCategoryEntries: true,
        featured: [current, community],
        sections: [
          { category: "research", items },
          { category: "coding", items: [current] },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const overview = await readClawHubTemplatesOverview({
      baseUrl: "https://registry.example",
      limit: 1,
      includeCategoryEntries: true,
    });
    expect(overview).toMatchObject({
      featured: [{ packageName }],
      sections: [
        {
          category: "research",
          entries: [{ packageName: personalPackageName }],
          additionalEntries: [
            { packageName, displayName: "Current release", installs: 7 },
            { packageName: "@openclaw/zebra", installs: 7 },
          ],
        },
        { category: "coding", entries: [{ packageName }], additionalEntries: [] },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://registry.example/api/v1/templates/overview?limit=1&include=categoryEntries",
    );
    const legacy = vi.fn(async (input: URL | string) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/templates/catalog-page") {
        return new Response(null, { status: 404 });
      }
      expect(url.pathname).toBe("/api/v1/packages");
      return Response.json({ items, nextCursor: null });
    });
    vi.stubGlobal("fetch", legacy);
    const { entries: category } = await searchClawHubTemplates({ category: "research", baseUrl });
    const research = overview?.sections[0];
    expect([...(research?.entries ?? []), ...(research?.additionalEntries ?? [])]).toEqual(
      category,
    );
  });

  it.each([
    { status: 404, body: {}, fallback: true },
    { status: 200, body: { complete: false, completeCategoryEntries: true }, fallback: true },
    { status: 200, body: { complete: true, featured: [] }, fallback: false },
    ...[401, 403, 429, 500].map((status) => ({ status, body: {}, fallback: false })),
  ])(
    "uses legacy shelves only for 404/incomplete, not $status failures ($fallback)",
    async ({ status, body, fallback }) => {
      const fetch = vi.fn(async () =>
        Response.json(body, { status, headers: { "retry-after": "61" } }),
      );
      vi.stubGlobal("fetch", fetch);
      const result = readClawHubTemplatesOverview({
        baseUrl: "https://registry.example",
        includeCategoryEntries: true,
      });
      if (fallback) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow();
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

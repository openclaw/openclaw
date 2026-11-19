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
  it("ranks the complete legacy category before slicing each page", async () => {
    const upstream = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
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
      null,
      "registry-next",
      null,
      "registry-next",
    ]);
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
      const limit = Number(new URL(input).searchParams.get("limit"));
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
      "100",
      "100",
      "100",
    ]);
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
import * as ranking from "./tool-search-ranking.js";
import {
  buildLexicalIndex,
  readParameterText,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

afterEach(() => vi.restoreAllMocks());

function entry(partial: Partial<ToolSearchCatalogEntry>): ToolSearchCatalogEntry {
  return {
    id: partial.name ?? "id",
    source: "openclaw",
    name: "tool",
    description: "",
    tool: {} as never,
    ...partial,
  } as ToolSearchCatalogEntry;
}

const CATALOG = [
  entry({ name: "web_search", description: "Search the web for current information" }),
  entry({ name: "read_file", description: "Read a file from disk" }),
  entry({ name: "cron_create", description: "Schedule a recurring task" }),
  entry({ name: "spreadsheet_open", description: "Open a spreadsheet document" }),
  entry({
    name: "issue_create",
    description: "Open a new issue",
    parameters: {
      type: "object",
      properties: { repository: { type: "string", description: "Target repository" } },
    },
  }),
];

const searchConfig = {
  enabled: true,
  mode: "directory" as const,
  searchDefaultLimit: 10,
  maxSearchLimit: 50,
};
function runtime(catalog = CATALOG): ToolSearchRuntime {
  const catalogRef = createToolSearchCatalogRef();
  catalogRef.current = {
    entries: catalog,
    counterScope: "scope-1",
    searchCount: 0,
    describeCount: 0,
    callCount: 0,
  };
  return new ToolSearchRuntime({ catalogRef }, searchConfig);
}
const catalogRuntime = (catalog: Parameters<typeof entry>[0][]) => runtime(catalog.map(entry));
const objectSchema = <T>(properties: T) => ({ type: "object", properties });
const queryTerms = (query: string) => tokenizeQuery(query).map(({ term }) => term);
const document = (value: string, text: string) => ({ value, terms: tokenizeDocument(text) });

const searchField =
  (field: "name" | "id") =>
  async (
    search: ToolSearchRuntime,
    query: string,
    options?: Parameters<ToolSearchRuntime["search"]>[1],
  ) =>
    (await search.search(query, options)).map((hit) => hit[field]);
const names = searchField("name"),
  ids = searchField("id");

it.each([
  ["running", "run"],
  ["calling", "call"],
  ["processing", "process"],
  ["news", "news"],
])("normalizes %s to its root %s", (word, root) => {
  expect(tokenizeDocument(word)).toEqual([root]);
});

it("fires expansions for -ies plurals of a trigger word", () => {
  expect(queryTerms("list directories")).toContain(tokenizeDocument("file")[0]);
});

it("keeps capability verbs that name real operations", () => {
  expect(queryTerms("get")).not.toEqual([]);
});

it("expands intent words toward the vocabulary descriptions use", () => {
  const terms = tokenizeQuery("look up the price");
  const search = terms.find((term) => term.term === tokenizeDocument("search")[0]);

  expect(search).toBeDefined();
  expect(search?.weight).toBeLessThan(1);
  expect(terms.find((term) => term.term === tokenizeDocument("price")[0])?.weight).toBe(1);
});

it("does not let a singular/plural collision invent an intent", () => {
  expect(queryTerms("open a new issue")).not.toContain(tokenizeDocument("search")[0]);
});

it("includes empty documents in length normalization without creating search hits", () => {
  const value = { id: "match" };
  const index = buildLexicalIndex([
    { value, terms: ["needle", "needle"] },
    { value: { id: "empty" }, terms: [] },
  ]);

  expect(index).toMatchObject({ documentCount: 2, averageLength: 1 });
  const hits = scoreLexical(index, [{ term: "needle", weight: 1 }]);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.value).toBe(value);
  expect(hits[0]?.matchedLiteral).toBe(true);
  expect(hits[0]?.score).toBeCloseTo((Math.log(2) * 2 * 2.2) / (2 + 1.2 * 1.75));
});

it("indexes non-Latin text rather than discarding it", () => {
  const index = buildLexicalIndex([document("jp", "価格 lookup")]);

  expect(scoreLexical(index, tokenizeQuery("価格")).map((hit) => hit.value)).toEqual(["jp"]);
});

it("marks literal overlap so callers can rank it ahead of expansion-only hits", () => {
  const index = buildLexicalIndex([
    document("weather-a", "weather_now Report the weather"),
    document("weather-b", "weather_hourly Hourly weather"),
    document("weather-c", "weather_alerts Weather alerts"),
    document("web", "web_search Search the web"),
  ]);

  const hits = scoreLexical(index, tokenizeQuery("weather"));
  const web = hits.find((hit) => hit.value === "web");

  expect(hits.filter((hit) => hit.matchedLiteral).map((hit) => hit.value)).toContain("weather-a");
  expect(web?.matchedLiteral).toBe(false);
});

it.each(["client", "mcp"] as const)(
  "never traverses parameters from the untrusted %s source",
  async (source) => {
    const properties = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("client properties must remain deferred");
        },
      },
    );
    const hostile = entry({
      source,
      name: "client_pick_file",
      description: "Ask the client to pick a file",
      parameters: objectSchema(properties),
    });
    const search = runtime([...CATALOG, hostile]);

    await expect(search.search("pick a file")).resolves.toBeDefined();
    expect(await names(search, "client_pick_file")).toContain("client_pick_file");
  },
);

it("refreshes metadata inside anyOf branches after edits", async () => {
  const branch = objectSchema({ orchard: { type: "string", description: "Collect apples" } });
  const catalogRef = createToolSearchCatalogRef();
  const tools = [
    {
      ...createStubTool("indexed_resource"),
      parameters: { anyOf: [{ description: "Measure asteroids" }, branch] },
    },
  ];
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const search = new ToolSearchRuntime({ catalogRef }, { ...searchConfig, mode: "tools" });

  for (const query of ["asteroids", "orchard", "apples"]) {
    expect(await names(search, query)).toEqual(["indexed_resource"]);
  }
  branch.properties.orchard.description = "Observe meteors";
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  expect(await names(search, "meteors")).toEqual(["indexed_resource"]);
  expect(await search.search("apples")).toEqual([]);
  expect(await search.search("orchard", { allowedIds: new Set() })).toEqual([]);
});

it("finds metadata through composed property and array-item schemas", async () => {
  const items = { allOf: [{ type: "string", description: "Observe meteors" }] };
  const search = catalogRuntime([
    {
      name: "indexed_resource",
      parameters: objectSchema({
        resources: {
          anyOf: [{ type: "null" }, { type: "array", items }],
        },
      }),
    },
  ]);

  expect(await names(search, "meteors")).toEqual(["indexed_resource"]);
});

it("prepares search text and its revision once across warm searches and runtimes", async () => {
  const catalog = CATALOG.map((item) => entry({ ...item, id: `warm-index:${item.id}` }));
  const render = vi.spyOn(ranking, "readParameterText");
  const build = vi.spyOn(ranking, "buildLexicalIndex");
  const allowedIds = new Set(catalog.map(({ id }) => id));
  for (let turn = 0; turn < 3; turn++) {
    const search = runtime(catalog);
    expect(await names(search, "repository", { allowedIds })).toEqual(["issue_create"]);
    expect(await names(search, "read", { allowedIds })).toEqual(["read_file"]);
  }
  expect(render).toHaveBeenCalledTimes(catalog.length);
  expect(build).toHaveBeenCalledTimes(1);
  allowedIds.delete(catalog[4]!.id);
  expect(await runtime(catalog).search("repository", { allowedIds })).toEqual([]);
  allowedIds.add(catalog[4]!.id);
  expect(await names(runtime(catalog), "repository", { allowedIds })).toEqual(["issue_create"]);
  expect(render).toHaveBeenCalledTimes(catalog.length);
  expect(build).toHaveBeenCalledTimes(2);
});

it("keeps BM25 population statistics scoped to the current visibility", async () => {
  const search = catalogRuntime([
    { name: "first", description: "alpha alpha" },
    { name: "second", description: "beta" },
    ...["third", "fourth", "fifth"].map((name) => ({ name, description: "alpha" })),
  ]);
  const allowedIds = new Set(["first", "second"]);
  expect((await search.search("alpha beta", { limit: 1 }))[0]?.name).toBe("second");
  expect((await search.search("alpha beta", { allowedIds, limit: 1 }))[0]?.name).toBe("first");
  allowedIds.add("third").add("fourth").add("fifth");
  expect((await search.search("alpha beta", { allowedIds, limit: 1 }))[0]?.name).toBe("second");
});

it.each([
  { encoding: "ASCII", padding: " ", suffix: "" },
  { encoding: "Unicode", padding: " ", suffix: "価格 𐐀 \ud800" },
  { encoding: "Unicode word", padding: "λ", suffix: "" },
])(
  "shares oversized $encoding revisions while their indexes remain live",
  async ({ padding, suffix }) => {
    const catalog = [
      entry({
        name: "oversized_revision",
        description: `Retention ${padding.repeat(4 * 1024 * 1024)}${suffix}`,
      }),
    ];
    // The spy retains built indexes, as another active catalog view would.
    const build = vi.spyOn(ranking, "buildLexicalIndex");
    for (let turn = 0; turn < 2; turn++) {
      expect(await names(runtime(catalog), "retention")).toEqual(["oversized_revision"]);
    }
    expect(build).toHaveBeenCalledTimes(1);
  },
);

it("projects shared index hits from the current catalog without retaining another run's metadata", async () => {
  const first = entry({ name: "shared_revision", description: "Measure quasars" });
  await runtime([first]).search("quasars");
  const current = entry({ ...first, source: "mcp", sourceName: "current-server" });
  expect(await runtime([current]).search("quasars")).toMatchObject([
    { source: "mcp", sourceName: "current-server", input: "unknown" },
  ]);
});

it.each(["listURL", "listUrl"])("prefers the exact catalog ID spelling for %s", async (name) => {
  const search = catalogRuntime(
    ["listURL", "listUrl"].map((toolName) => ({
      id: `mcp:accounting:${toolName}`,
      name: toolName,
      source: "mcp" as const,
      description: "Find overdue invoices",
    })),
  );
  expect(await ids(search, `mcp:accounting:${name}`, { limit: 1 })).toEqual([
    `mcp:accounting:${name}`,
  ]);
});

it("preserves ranked exact-match order when the limit excludes other exact matches", async () => {
  const search = catalogRuntime([
    { id: "z", name: "harvest", description: "Collect records" },
    { id: "a", name: "harvest", description: "Collect records" },
    { id: "m", name: "HARVEST", description: "Collect records" },
    { name: "records", description: "harvest" },
  ]);

  expect(await ids(search, "harvest", { limit: 2 })).toEqual(["a", "m"]);
});

it("expands reminder toward schedule/cron", async () => {
  expect(await names(runtime(), "reminder")).toContain("cron_create");
});

it.each([
  ["cookies", "cooki"],
  ["policies", "policy"],
  ["getURLs", "url"],
  ["getOAuthToken", "auth"],
])("keeps plural or compound word parts addressable: %s", (name, part) => {
  expect(tokenizeDocument(name)).toContain(part);
});

it("returns a tool named exactly like a stopword", async () => {
  const search = catalogRuntime([
    { id: "z-local", name: "do", description: "Run a stored action" },
    { id: "a-remote", source: "mcp", name: "DO", description: "Run a remote action" },
    { id: "m-local", name: "do", description: "Run another stored action" },
    { id: "other", name: "other", description: "Unrelated" },
  ]);

  // "do" tokenizes to nothing; exact matches still retain catalog order,
  // with visibility applied before the result limit.
  expect(await ids(search, " DO ")).toEqual(["z-local", "a-remote", "m-local"]);
  expect(await ids(search, "do", { limit: 2 })).toEqual(["z-local", "a-remote"]);
  expect(await ids(search, "do", { includeMcp: false, limit: 1 })).toEqual(["z-local"]);
  expect(
    await ids(search, "do", {
      allowedIds: new Set(["a-remote", "m-local"]),
      includeMcp: false,
      limit: 1,
    }),
  ).toEqual(["m-local"]);
});

it("ignores boolean schemas and literal data while collecting composed metadata", () => {
  expect(
    readParameterText({
      description: "visible",
      const: { description: "literal" },
      enum: [{ description: "literal" }],
      anyOf: [true, false, { description: "branch" }],
      oneOf: [],
      allOf: [],
    }),
  ).toBe("visible branch");
});

it("keeps cyclic composed schemas bounded", () => {
  const schema: Record<string, unknown> = { description: "visible" };
  schema.anyOf = [schema];

  expect(readParameterText(schema).split(" ")).toEqual(Array(5).fill("visible"));
});

import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CatalogBrowseResultSchema,
  CatalogSearchKeywordsResultSchema,
  type CatalogBrowseResult,
  type CatalogSearchKeywordsResult,
} from "../../../packages/gateway-protocol/src/schema/catalog.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const local = vi.hoisted(() => ({ plugins: vi.fn(), skills: vi.fn() }));
// mock-isolation: Registered-handler proof uses synthetic inventory, never host installations.
vi.mock("../../plugins/management-service.js", () => ({
  listManagedPlugins: local.plugins,
  inspectManagedPlugin: vi.fn(),
}));
// mock-isolation: Per-agent fixture reports must not read actual workspace skill state.
vi.mock("../../skills/discovery/status.js", () => ({ prepareWorkspaceSkillStatus: local.skills }));

const registry = "https://catalog.example.test";
const skillRequest = { kind: "skill", agentId: "main" };
const trendingRequest = { ...skillRequest, feed: "trending" };
const skillMetadata = { name: "same-slug", displayName: "Same", family: "skill", updatedAt: 1 };
const config = {
  agents: {
    list: ["main", "other"].map((id) => ({ id, workspace: `/tmp/catalog-${id}` })),
  },
};
function plugin(name: string, official?: boolean) {
  return { name, displayName: name, family: "code-plugin", isOfficial: official };
}
function skill(owner: string, official?: boolean) {
  return { ...skillMetadata, ownerHandle: owner, isOfficial: official };
}
function trackedSkill(owner: string, skillRegistry = registry, requestedReference?: string) {
  return {
    skillKey: owner,
    clawhub: {
      valid: true,
      registry: skillRegistry,
      slug: "same-slug",
      ownerHandle: owner,
      ...(requestedReference ? { requestedReference } : {}),
    },
  };
}

type Params = Record<string, unknown>;
type CatalogResults = {
  browse: CatalogBrowseResult;
  searchKeywords: CatalogSearchKeywordsResult;
};
async function call<M extends keyof CatalogResults>(action: M, params: Params) {
  const method = `catalog.${action}`;
  const respond = vi.fn<RespondFn>();
  await coreGatewayHandlers[method]!({
    req: { type: "req", id: "catalog", method, params },
    params,
    client: null,
    context: { getRuntimeConfig: () => config } as never,
    isWebchatConnect: () => false,
    respond,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  const [ok, result, error] = respond.mock.calls[0]!;
  return { ok, result: result as CatalogResults[M], error };
}

function stubFetch(body: (url: URL) => unknown) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(body(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function stubRegistry(rows: unknown[], nextCursor?: string) {
  return stubFetch((url) =>
    url.pathname.endsWith("/search")
      ? { results: rows.map((entry) => ({ score: 1, package: entry })) }
      : { items: rows, nextCursor },
  );
}
function trendingSkill(source: string, displayName: string, reference: string) {
  return {
    slug: "same-slug",
    displayName,
    source,
    official: true,
    publisher: { handle: "alice", ...(source === "clawhub" ? { official: true } : {}) },
    install: { kind: source, reference },
  };
}
function installedPlugin(id: string, enabled: boolean, metadata: Params) {
  return {
    id,
    installed: true,
    enabled,
    state: enabled ? "enabled" : "disabled",
    ...metadata,
  };
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_CLAWHUB_URL", registry);
  vi.stubEnv("CLAWHUB_TOKEN", "fixture-catalog-token");
  local.plugins.mockReset().mockResolvedValue({
    mutationAllowed: true,
    plugins: [
      installedPlugin("local-bundle", true, { origin: "bundled" }),
      installedPlugin("installed", false, { clawhubPackage: "official-plugin" }),
    ],
  });
  local.skills.mockReset().mockImplementation(async (_dir, options) => ({
    report: {
      agentId: options.agentId,
      skills:
        options.agentId === "main"
          ? [
              trackedSkill("alice"),
              trackedSkill("bob", "https://other.example.test"),
              trackedSkill("external", registry, "skills-sh:alice/repo/same-slug"),
            ]
          : [],
    },
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ["plugin", false],
  ["skill", false],
  ["plugin", true],
  ["skill", true],
] as const)("filters %s listings and bounds continuation (search=%s)", async (kind, search) => {
  const row = kind === "plugin" ? plugin : skill;
  const official = row(kind === "plugin" ? "official-plugin" : "alice", true);
  const community = row("community", false);
  const fetchMock = stubRegistry(
    search ? [community, official] : [official, community, row("missing")],
    "page-two",
  );
  const request = {
    kind,
    agentId: "main",
    pageSize: search ? 2 : 3,
    ...(search ? { query: "calendar" } : {}),
  };
  const found = await call("browse", { ...request, officialOnly: true });
  expect(Value.Check(CatalogBrowseResultSchema, found.result)).toBe(true);
  expect(found).toMatchObject({
    ok: true,
    result: { items: [{ kind, catalog: { official: true }, local: { installed: true } }] },
  });
  if (search) {
    expect(found.result).toMatchObject({ mode: "search", searchLimit: 2 });
    expect(found.result.nextCursor).toBeUndefined();
    const invalid = await call("browse", { ...request, cursor: "browse-cursor" });
    expect(invalid.error?.code).toBe("INVALID_REQUEST");
  } else {
    expect(found.result.nextCursor).toBe("page-two");
    const second = await call("browse", {
      ...request,
      officialOnly: false,
      cursor: found.result.nextCursor,
    });
    expect(second.result.items).toHaveLength(3);
    const input = fetchMock.mock.calls[1]![0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.searchParams.get("cursor")).toBe("page-two");
  }
  expect(resolveCoreOperatorGatewayMethodScope("catalog.browse")).toBe("operator.read");
});

it("keeps native publisher, registry, external source, and selected agent installation state distinct", async () => {
  stubRegistry([skill("alice", true), skill("bob", true), skill("external", true)]);
  const first = await call("browse", skillRequest);
  expect(first.result.items.map((entry) => [entry.id, entry.local.installed])).toEqual([
    ["@alice/same-slug", true],
    ["@bob/same-slug", false],
    ["@external/same-slug", false],
  ]);
  const other = await call("browse", { ...skillRequest, agentId: "other" });
  expect(other.result.items.every((entry) => !entry.local.installed)).toBe(true);
  expect(local.skills.mock.calls.map(([workspace]) => workspace)).toEqual([
    "/tmp/catalog-main",
    "/tmp/catalog-other",
  ]);
  const invalid = await call("browse", { kind: "skill", agentId: "unknown" });
  expect(invalid.error?.code).toBe("INVALID_REQUEST");
});

it("qualifies trending native skills with listing flags and preserves install-only external identities", async () => {
  stubFetch((url) => {
    if (url.pathname.startsWith("/api/v1/packages/")) {
      return { package: skill("alice", false) };
    }
    return {
      items: [
        trendingSkill("clawhub", "Official publisher", "alice/same-slug"),
        trendingSkill("skills-sh", "External", "skills-sh:alice/repo/same-slug"),
      ],
      nextCursor: "trending-page-two",
    };
  });
  const general = await call("browse", trendingRequest);
  expect(general.result.mode).toBe("trending");
  expect(general.result.items[1]).toMatchObject({
    id: "skills-sh:alice/repo/same-slug",
    installOnly: true,
    local: { installed: true },
  });
  const official = await call("browse", { ...trendingRequest, officialOnly: true });
  expect(official.result).toMatchObject({ items: [], nextCursor: "trending-page-two" });
});

it("distinguishes empty results from malformed registry responses and local status failures", async () => {
  stubRegistry([]);
  expect((await call("browse", { kind: "plugin" })).result).toEqual({
    items: [],
    mode: "catalog",
  });
  stubFetch(() => ({ error: "unavailable" }));
  const failure = await call("browse", { kind: "plugin", cursor: "retry-page" });
  expect(failure.result).toMatchObject({
    items: [],
    nextCursor: "retry-page",
    remoteError: expect.stringContaining("Malformed"),
  });
  local.plugins.mockRejectedValue(new Error("Inventory unavailable"));
  const statusFailure = await call("browse", { kind: "plugin" });
  expect(statusFailure).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
});

it("pages the deduplicated official union without combining keywords or truncating matches", async () => {
  const fetchMock = stubFetch((url) => {
    const rows = url.pathname.includes("plugins")
      ? [plugin("official-plugin", true), plugin("community", false)]
      : [skill("alice", true), skill("bob", true), skill("unknown")];
    return { results: rows.map((entry) => ({ score: 1, package: entry })) };
  });
  const request = {
    keywords: [" Calendar  ", "calendar", "   Office   tools "],
    agentId: "main",
    pageSize: 1,
  };
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await call("searchKeywords", {
      ...request,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.ok).toBe(true);
    expect(Value.Check(CatalogSearchKeywordsResultSchema, page.result)).toBe(true);
    expect(page.result).toMatchObject({
      keywords: ["calendar", "office tools"],
      searchLimit: 100,
      errors: [],
    });
    all.push(...page.result.items);
    cursor = page.result.nextCursor;
  } while (cursor);
  expect(all).toHaveLength(3);
  expect(new Set(all.map((entry) => `${entry.kind}:${entry.registry}:${entry.id}`)).size).toBe(3);
  expect(
    new Set(
      fetchMock.mock.calls.map(([input]) =>
        new URL(input instanceof Request ? input.url : String(input)).searchParams.get("q"),
      ),
    ),
  ).toEqual(new Set(["calendar", "office tools"]));
  expect(resolveCoreOperatorGatewayMethodScope("catalog.searchKeywords")).toBe("operator.read");
});

it("accepts 100 keywords and returns explicit partial failures", async () => {
  stubFetch((url) => (url.searchParams.get("q") === "term0" ? { failure: true } : { results: [] }));
  const page = await call("searchKeywords", {
    keywords: Array.from({ length: 100 }, (_, index) => `term${index}`),
    kinds: ["plugin"],
  });
  expect(page.ok).toBe(true);
  expect(page.result.errors).toEqual([
    { kind: "plugin", query: "term0", message: expect.stringContaining("Malformed") },
  ]);
  expect(page.result.items).toEqual([]);
  expect(local.skills).not.toHaveBeenCalled();
});

it("binds bulk cursors to terms and continues through changed matches", async () => {
  stubRegistry([plugin("one", true), plugin("two", true)]);
  const request = { keywords: ["calendar"], kinds: ["plugin"], pageSize: 1 };
  const first = await call("searchKeywords", request);
  const wrongTerms = await call("searchKeywords", {
    ...request,
    keywords: ["other"],
    cursor: first.result.nextCursor,
  });
  expect(wrongTerms.error?.code).toBe("INVALID_REQUEST");
  stubRegistry([plugin("one", true), plugin("three", true)]);
  const changed = await call("searchKeywords", {
    ...request,
    cursor: first.result.nextCursor,
  });
  expect(changed).toMatchObject({
    ok: true,
    result: { items: [{ catalog: { name: "three" } }] },
  });
});

it.each([
  ["browse", { kind: "plugin", query: "calendar", cursor: "browse-cursor" }],
  ["browse", { kind: "plugin", query: "calendar", feed: "trending" }],
  ["browse", { kind: "plugin", pageSize: 101 }],
  ["browse", { kind: "plugin", pageSize: 0 }],
  ["browse", { kind: "claw" }],
  ["searchKeywords", { keywords: [" "] }],
  ["searchKeywords", { keywords: [] }],
  ["searchKeywords", { keywords: Array.from({ length: 101 }, () => "term") }],
] as const)("rejects invalid bounded requests for %s", async (method, request) => {
  const result = await call(method, request);
  expect(result.error?.code).toBe("INVALID_REQUEST");
  expect(local.plugins).not.toHaveBeenCalled();
  expect(local.skills).not.toHaveBeenCalled();
});

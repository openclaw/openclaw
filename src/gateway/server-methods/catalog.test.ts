import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogBrowseResultSchema,
  CatalogSearchKeywordsResultSchema,
  type CatalogBrowseResult,
  type CatalogSearchKeywordsResult,
} from "../../../packages/gateway-protocol/src/schema/catalog.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const local = vi.hoisted(() => ({ plugins: vi.fn(), skills: vi.fn() }));
// mock-isolation: Registered-handler proof uses synthetic inventory, never host installations.
vi.mock("../../plugins/management-service.js", () => ({
  listManagedPlugins: local.plugins,
  inspectManagedPlugin: vi.fn(),
}));
// mock-isolation: Per-agent fixture reports must not read actual workspace skill state.
vi.mock("../../skills/discovery/status.js", () => ({ prepareWorkspaceSkillStatus: local.skills }));

const registry = "https://catalog.example.test";
const config = {
  agents: {
    list: [
      { id: "main", workspace: "/tmp/catalog-main" },
      { id: "other", workspace: "/tmp/catalog-other" },
    ],
  },
};
function plugin(name: string, official?: boolean) {
  return {
    name,
    displayName: name,
    family: "code-plugin",
    isOfficial: official,
    categories: [],
    ownerHandle: "openclaw",
    verificationTier: "verified",
    featured: true,
  };
}
function skill(owner: string, official?: boolean, name = "same-slug") {
  return {
    name,
    displayName: "Same display name",
    family: "skill",
    ownerHandle: owner,
    isOfficial: official,
    latestVersion: "1.0.0",
    updatedAt: 1,
  };
}
function trackedSkill(owner: string, skillRegistry = registry, requestedReference?: string) {
  return {
    skillKey: owner,
    name: "Same display name",
    disabled: false,
    eligible: true,
    blockedByAgentFilter: false,
    clawhub: {
      valid: true,
      registry: skillRegistry,
      slug: "same-slug",
      ownerHandle: owner,
      ...(requestedReference ? { requestedReference } : {}),
    },
  };
}

type CallResult<T> = { ok: boolean; result: T; error: ErrorShape | undefined };

function call(
  method: "catalog.browse",
  params: Record<string, unknown>,
): Promise<CallResult<CatalogBrowseResult>>;
function call(
  method: "catalog.searchKeywords",
  params: Record<string, unknown>,
): Promise<CallResult<CatalogSearchKeywordsResult>>;
function call(
  method: string,
  params: Record<string, unknown>,
): Promise<CallResult<CatalogBrowseResult | CatalogSearchKeywordsResult>>;
async function call(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "catalog", method, params },
    params,
    client: null,
    context: { getRuntimeConfig: () => config } as never,
    isWebchatConnect: () => false,
    respond,
  };
  await coreGatewayHandlers[method]!(options);
  expect(respond).toHaveBeenCalledTimes(1);
  const [ok, result, error] = respond.mock.calls[0]!;
  return {
    ok: ok as boolean,
    result: result as CatalogBrowseResult | CatalogSearchKeywordsResult,
    error: error as ErrorShape | undefined,
  };
}

function stubRegistry(rows: unknown[], nextCursor?: string) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(
      url.pathname.endsWith("/search")
        ? { results: rows.map((entry) => ({ score: 1, package: entry })) }
        : { items: rows, nextCursor },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_CLAWHUB_URL", registry);
  vi.stubEnv("CLAWHUB_TOKEN", "fixture-catalog-token");
  local.plugins.mockReset().mockResolvedValue({
    mutationAllowed: true,
    diagnostics: [],
    plugins: [
      {
        id: "local-bundle",
        name: "Bundled",
        installed: true,
        enabled: true,
        origin: "bundled",
        state: "enabled",
      },
      {
        id: "installed",
        name: "Installed",
        clawhubPackage: "official-plugin",
        installed: true,
        enabled: false,
        state: "disabled",
      },
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

describe("registered Gateway catalog discovery", () => {
  it.each(["plugin", "skill"] as const)(
    "filters %s listing flags in the Gateway and retains upstream cursors",
    async (kind) => {
      const rows =
        kind === "plugin"
          ? [plugin("official-plugin", true), plugin("community", false), plugin("missing")]
          : [skill("alice", true), skill("bob", false), skill("missing")];
      const fetchMock = stubRegistry(rows, "page-two");
      const first = await call("catalog.browse", {
        kind,
        officialOnly: true,
        agentId: "main",
        pageSize: 3,
      });
      expect(first.ok).toBe(true);
      expect(Value.Check(CatalogBrowseResultSchema, first.result)).toBe(true);
      expect(first.result.items).toHaveLength(1);
      expect(first.result.items[0]).toMatchObject({
        kind,
        catalog: { official: true },
        local: { installed: true },
      });
      expect(first.result.nextCursor).toBe("page-two");
      const second = await call("catalog.browse", {
        kind,
        officialOnly: false,
        agentId: "main",
        cursor: first.result.nextCursor,
        pageSize: 3,
      });
      expect(second.result.items).toHaveLength(3);
      const input = fetchMock.mock.calls[1]![0];
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.searchParams.get("cursor")).toBe("page-two");
      expect(resolveCoreOperatorGatewayMethodScope("catalog.browse")).toBe("operator.read");
    },
  );

  it.each(["plugin", "skill"] as const)(
    "declares the %s search bound and rejects invented search continuation",
    async (kind) => {
      stubRegistry(
        kind === "plugin"
          ? [plugin("community", false), plugin("official-plugin", true)]
          : [skill("community", false), skill("alice", true)],
      );
      const found = await call("catalog.browse", {
        kind,
        query: "calendar",
        officialOnly: true,
        pageSize: 2,
        agentId: "main",
      });
      expect(found.result).toMatchObject({ mode: "search", searchLimit: 2 });
      expect(found.result.items).toHaveLength(1);
      expect(found.result.nextCursor).toBeUndefined();
      const invalid = await call("catalog.browse", {
        kind,
        query: "calendar",
        cursor: "browse-cursor",
        agentId: "main",
      });
      expect(invalid.error?.code).toBe("INVALID_REQUEST");
    },
  );

  it("keeps native publisher, registry, external source, and selected agent installation state distinct", async () => {
    stubRegistry([skill("alice", true), skill("bob", true), skill("external", true)]);
    const first = await call("catalog.browse", {
      kind: "skill",
      agentId: "main",
    });
    expect(first.result.items.map((entry) => [entry.id, entry.local.installed])).toEqual([
      ["@alice/same-slug", true],
      ["@bob/same-slug", false],
      ["@external/same-slug", false],
    ]);
    const other = await call("catalog.browse", {
      kind: "skill",
      agentId: "other",
    });
    expect(other.result.items.every((entry) => !entry.local.installed)).toBe(true);
    expect(local.skills.mock.calls.map(([workspace]) => workspace)).toEqual([
      "/tmp/catalog-main",
      "/tmp/catalog-other",
    ]);
    const invalid = await call("catalog.browse", { kind: "skill", agentId: "unknown" });
    expect(invalid.error?.code).toBe("INVALID_REQUEST");
  });

  it("qualifies trending native skills with listing flags and preserves install-only external identities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith("/api/v1/packages/")) {
          return Response.json({
            package: {
              family: "skill",
              name: "same-slug",
              ownerHandle: "alice",
              isOfficial: false,
            },
          });
        }
        return Response.json({
          items: [
            {
              slug: "same-slug",
              displayName: "Official publisher",
              source: "clawhub",
              official: true,
              publisher: { handle: "alice", official: true },
              metrics: { updatedAt: 1 },
              install: { kind: "clawhub", reference: "alice/same-slug" },
            },
            {
              slug: "same-slug",
              displayName: "External",
              source: "skills-sh",
              official: true,
              publisher: { handle: "alice" },
              metrics: { updatedAt: 1 },
              install: { kind: "skills-sh", reference: "skills-sh:alice/repo/same-slug" },
            },
          ],
          nextCursor: "trending-page-two",
        });
      }),
    );
    const general = await call("catalog.browse", {
      kind: "skill",
      feed: "trending",
      agentId: "main",
    });
    expect(general.result.mode).toBe("trending");
    expect(general.result.items[1]).toMatchObject({
      id: "skills-sh:alice/repo/same-slug",
      installOnly: true,
      local: { installed: true },
    });
    const official = await call("catalog.browse", {
      kind: "skill",
      feed: "trending",
      officialOnly: true,
      agentId: "main",
    });
    expect(official.result.items).toEqual([]);
    expect(official.result.nextCursor).toBe("trending-page-two");
  });

  it("distinguishes empty results from malformed registry responses and local status failures", async () => {
    stubRegistry([]);
    expect((await call("catalog.browse", { kind: "plugin" })).result).toEqual({
      items: [],
      mode: "catalog",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "unavailable" })),
    );
    const failure = await call("catalog.browse", {
      kind: "plugin",
      cursor: "retry-page",
    });
    expect(failure.result).toMatchObject({
      items: [],
      nextCursor: "retry-page",
      remoteError: expect.stringContaining("Malformed"),
    });
    local.plugins.mockRejectedValue(new Error("Inventory unavailable"));
    const statusFailure = await call("catalog.browse", { kind: "plugin" });
    expect(statusFailure.ok).toBe(false);
    expect(statusFailure.error?.code).toBe("UNAVAILABLE");
  });

  it("pages the deduplicated official union without combining keywords or truncating matches", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = new URL(String(input));
      const rows = url.pathname.includes("plugins")
        ? [plugin("official-plugin", true), plugin("community", false)]
        : [skill("alice", true), skill("bob", true), skill("unknown")];
      return Response.json({ results: rows.map((entry) => ({ score: 1, package: entry })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      keywords: [" Calendar  ", "calendar", "   Office   tools "],
      agentId: "main",
      pageSize: 1,
    };
    const all = [];
    let cursor: string | undefined;
    do {
      const page = await call("catalog.searchKeywords", {
        ...request,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.ok).toBe(true);
      expect(Value.Check(CatalogSearchKeywordsResultSchema, page.result)).toBe(true);
      expect(page.result.keywords).toEqual(["calendar", "office tools"]);
      expect(page.result.searchLimit).toBe(100);
      expect(page.result.errors).toEqual([]);
      all.push(...page.result.items);
      cursor = page.result.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(3);
    expect(new Set(all.map((entry) => `${entry.kind}:${entry.registry}:${entry.id}`)).size).toBe(3);
    expect(
      new Set(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))),
    ).toEqual(new Set(["calendar", "office tools"]));
    expect(resolveCoreOperatorGatewayMethodScope("catalog.searchKeywords")).toBe("operator.read");
  });

  it("accepts 100 keywords and returns explicit partial failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input));
        return Response.json(
          url.searchParams.get("q") === "term0" ? { failure: true } : { results: [] },
        );
      }),
    );
    const page = await call("catalog.searchKeywords", {
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

  it("binds bulk cursors to the terms and result set and rejects changed matches", async () => {
    stubRegistry([plugin("one", true), plugin("two", true)]);
    const request = { keywords: ["calendar"], kinds: ["plugin"], pageSize: 1 };
    const first = await call("catalog.searchKeywords", request);
    const wrongTerms = await call("catalog.searchKeywords", {
      ...request,
      keywords: ["other"],
      cursor: first.result.nextCursor,
    });
    expect(wrongTerms.error?.code).toBe("INVALID_REQUEST");
    stubRegistry([plugin("one", true)]);
    const changed = await call("catalog.searchKeywords", {
      ...request,
      cursor: first.result.nextCursor,
    });
    expect(changed.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("matches changed"),
    });
  });

  it.each([
    ["catalog.browse", { kind: "plugin", pageSize: 101 }],
    ["catalog.browse", { kind: "plugin", pageSize: 0 }],
    ["catalog.browse", { kind: "claw" }],
    ["catalog.searchKeywords", { keywords: [" "] }],
    ["catalog.searchKeywords", { keywords: [] }],
    ["catalog.searchKeywords", { keywords: Array.from({ length: 101 }, () => "term") }],
  ])("rejects invalid bounded requests for %s", async (method, request) => {
    const result = await call(method, request);
    expect(result.error?.code).toBe("INVALID_REQUEST");
    expect(local.plugins).not.toHaveBeenCalled();
    expect(local.skills).not.toHaveBeenCalled();
  });
});

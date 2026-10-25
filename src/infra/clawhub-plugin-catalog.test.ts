import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { PluginDiscoveryDetailSchema } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { joinClawHubPluginDetail } from "../plugins/catalog-discovery.js";
import { jsonResponse } from "../test-helpers/http.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  fetchClawHubPluginCatalog,
  fetchClawHubPluginCategories,
  fetchClawHubPluginOverview,
  fetchClawHubPluginVersionCategories,
  fetchClawHubPluginDetail,
} from "./clawhub-plugin-catalog.js";
import { captureClawHubJson as mockResponse } from "./clawhub.test-support.js";

const registry = { baseUrl: "https://example.com" };
const remotePlugin = {
  name: "memory-plus",
  displayName: "Memory Plus",
  family: "code-plugin",
  isOfficial: false,
  summary: "Long-term memory",
  ownerHandle: "alice",
  categories: ["memory"],
  latestVersion: "1.2.3",
  runtimeId: "memory-plus",
  ownerImage: "https://cdn.example.com/alice.png",
  icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
  stats: { downloads: 42, installs: 7 },
};

const remoteCategory = {
  slug: "models",
  label: "Models",
  description: "Model providers.",
  icon: "brain",
  order: 1,
};

async function catalog(
  options: Parameters<typeof fetchClawHubPluginCatalog>[0],
  response: unknown = { items: [remotePlugin] },
) {
  const fetchImpl = mockResponse(response);
  const result = await fetchClawHubPluginCatalog({ ...registry, ...options });
  return { result, url: fetchImpl.url() };
}

function readCategories(categories: unknown[]) {
  mockResponse({ categories });
  return fetchClawHubPluginCategories(registry);
}

function readDetail(value: Record<string, unknown>, version?: string) {
  mockResponse({ package: remotePlugin, versions: { items: [] }, ...value });
  return fetchClawHubPluginDetail({
    ...registry,
    packageName: "memory-plus",
    version,
    skipAuth: true,
  });
}

function joinDetail(remote: Awaited<ReturnType<typeof fetchClawHubPluginDetail>>) {
  return joinClawHubPluginDetail({
    remote,
    local: { plugins: [], diagnostics: [], mutationAllowed: true },
  }).detail;
}

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "attributes searches and retries only unrecorded requests: telemetry disabled=%s",
  async (disabled) => {
    await withEnvAsync({ CLAWHUB_DISABLE_TELEMETRY: String(disabled) }, async () => {
      const fetchImpl = vi
        .fn(async (_input: string | URL | Request) =>
          jsonResponse({ results: [{ score: 9, package: remotePlugin }] }),
        )
        .mockRejectedValueOnce(new TypeError("fetch failed"));
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
      const result = fetchClawHubPluginCatalog({
        ...registry,
        query: "memory",
        searchSource: "openclaw-control-ui",
        category: "memory",
        limit: 5,
      });
      if (disabled) {
        await expect(result).resolves.toMatchObject({ items: [{ packageName: "memory-plus" }] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } else {
        await expect(result).rejects.toThrow("fetch failed");
        expect(fetchImpl).toHaveBeenCalledOnce();
      }
      const input = fetchImpl.mock.calls[0]?.[0];
      if (!input) {
        throw new Error("Expected a catalog request");
      }
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe("/api/v1/plugins/search");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        q: "memory",
        category: "memory",
        limit: "5",
        ...(disabled ? {} : { searchSource: "openclaw-control-ui" }),
      });
    });
  },
);

it.each([
  ["overview", fetchClawHubPluginOverview],
  ["categories", fetchClawHubPluginCategories],
])("public %s omits ambient auth unless requested", async (_name, read) => {
  await withEnvAsync(
    {
      CLAWHUB_TOKEN: "ambient-test-token",
      OPENCLAW_CLAWHUB_URL: undefined,
      CLAWHUB_URL: undefined,
    },
    async () => {
      const authorization: Array<string | null> = [];
      const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
        authorization.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse({ items: [remotePlugin], categories: [remoteCategory] });
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
      await read({});
      await read({ skipAuth: false });
      await read({ token: "explicit-test-token" });
      await read({ baseUrl: "https://private.example/clawhub" });
      await read({ baseUrl: "https://private.example/clawhub", skipAuth: true });
      for (const key of ["OPENCLAW_CLAWHUB_URL", "CLAWHUB_URL"]) {
        await withEnvAsync({ [key]: "https://private.example/clawhub" }, async () => {
          await read({});
        });
      }
      expect(authorization).toEqual([
        null,
        "Bearer ambient-test-token",
        "Bearer explicit-test-token",
        "Bearer ambient-test-token",
        null,
        "Bearer ambient-test-token",
        "Bearer ambient-test-token",
      ]);
    },
  );
});

it("reads ranked plugins and categories from the overview", async () => {
  const ranking = { featured: true, trending: true, featuredRank: 1, trendingRank: 0 };
  const fetchImpl = mockResponse({
    categories: [remoteCategory],
    items: [{ ...remotePlugin, ...ranking }],
  });

  const result = await fetchClawHubPluginOverview(registry);

  expect(fetchImpl.url().pathname).toBe("/api/v1/plugins/overview");
  expect(result.categories).toEqual([remoteCategory]);
  expect(result.items).toMatchObject([
    {
      packageName: "memory-plus",
      iconUrl: `https://example.com${remotePlugin.icon}`,
      ...ranking,
    },
  ]);
});

it("browses the combined plugin endpoint with an opaque cursor", async () => {
  const { result, url } = await catalog(
    { intent: "trending", category: "memory", cursor: "pkgplugins:{opaque}", limit: 12 },
    { items: [remotePlugin], nextCursor: "pkgplugins:{opaque}" },
  );
  expect(url.pathname).toBe("/api/v1/plugins");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    category: "memory",
    cursor: "pkgplugins:{opaque}",
    sort: "trending",
    limit: "12",
  });
  expect(result).toMatchObject({
    items: [{ packageName: "memory-plus", downloads: 42, installs: 7 }],
    nextCursor: "pkgplugins:{opaque}",
  });
});

it("uses plugin search with a publisher icon fallback and no invented pagination", async () => {
  const { result, url } = await catalog(
    { query: "memory", intent: "official", limit: 5 },
    { results: [{ score: 9, package: { ...remotePlugin, icon: null } }] },
  );
  expect(url.pathname).toBe("/api/v1/plugins/search");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: "memory",
    isOfficial: "true",
    limit: "5",
  });
  expect(result.nextCursor).toBeUndefined();
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.iconUrl).toBe(remotePlugin.ownerImage);
});

it.each([
  [
    { intent: "featured", limit: 6 },
    { featured: "true", limit: "6" },
  ],
  [
    { intent: "all", category: "models", limit: 8 },
    { category: "models", curated: "true", sort: "downloads", limit: "8" },
  ],
] as const)("preserves canonical ordering: %j", async (options, query) => {
  const category = { ...remoteCategory, pinnedPackages: ["@vendor/model"] };
  const { result, url } = await catalog(options, { items: [], categories: [category] });
  expect(url.pathname).toBe("/api/v1/plugins");
  expect(Object.fromEntries(url.searchParams)).toEqual(query);
  expect(result).toEqual({ items: [], categories: [category] });
});

it("validates and restores canonical category ordering", async () => {
  const categories = await readCategories([
    remoteCategory,
    { ...remoteCategory, slug: "channels", icon: "message-circle", order: 0 },
  ]);
  expect(categories.map((category) => category.slug)).toEqual(["channels", "models"]);
});

it.each([
  [{ pinnedPackages: ["@vendor/model", "@vendor/model"] }, "duplicate or invalid pinned package"],
  [{ icon: "lucide:wrench" }, "invalid icon key"],
])("rejects invalid category %j", async (fields, error) => {
  await expect(readCategories([{ ...remoteCategory, ...fields }])).rejects.toThrow(error);
});

it.each([
  { slug: "voice", icon: "mic", expected: "mic" },
  { slug: "models", icon: "new-upstream-icon", expected: "package" },
])("projects category icon $icon as $expected", async ({ slug, icon, expected }) => {
  await expect(readCategories([{ ...remoteCategory, slug, icon }])).resolves.toEqual([
    { ...remoteCategory, slug, icon: expected },
  ]);
});

it("batch-reads current and legacy categories for exact package versions", async () => {
  const packages = [
    { name: "@openclaw/memory", version: "1.2.3" },
    { name: "@openclaw/missing", version: "4.5.6" },
  ];
  const response = [
    { ...packages[0], categories: ["memory", "tools"] },
    { ...packages[1], categories: null },
  ];
  const request = mockResponse({ packages: response });

  const result = await fetchClawHubPluginVersionCategories({
    ...registry,
    token: "private-token",
    skipAuth: true,
    packages,
  });

  expect(request.init()?.method).toBe("POST");
  expect(new Headers(request.init()?.headers).has("authorization")).toBe(false);
  expect(request.url().pathname).toBe("/api/v1/packages/categories:batch");
  expect(request.body()).toEqual({ packages });
  expect(result).toEqual(response);
});

it.each([
  [
    ["widget", "page", "widget"],
    ["page", "widget"],
  ],
  [undefined, undefined],
  [[], []],
  ["page", undefined],
  [["page", "unknown"], undefined],
])("reads exact-version detail with UI metadata %j", async (ui, expected) => {
  const display = {
    topics: ["Retrieval"],
    tags: { latest: "1.2.3" },
    createdAt: 100,
    updatedAt: 300,
  };
  const owner = { handle: "alice", displayName: "Alice", official: true };
  const previous = { version: "1.2.2", createdAt: 200, changelog: "Previous release" };
  const current = { version: "1.2.3", createdAt: 300, changelog: "Current release" };
  const skills = [{ name: "Recall", description: "Recall saved knowledge" }];
  const configFields = [
    { name: "apiKey", description: "Service API key", required: true, sensitive: true },
  ];
  const mcpServers = [
    {
      name: "memory",
      url: "https://mcp.example.com/memory?mode=read",
      transport: "streamable-http",
      auth: "oauth",
      scope: "memory:read",
      setup: "Connect your account.",
    },
    { name: "legacy" },
  ];
  const capabilities = {
    contracts: { tools: ["memory_recall"], videoGenerationProviders: ["presenter"] },
    providers: ["memory-model"],
    channels: ["memory-chat"],
  };
  const verification = {
    tier: "source-linked",
    sourceRepo: "alice/memory-plus",
    scanStatus: "clean",
  };
  const security = {
    status: "review",
    verdict: "review",
    auditUrl: "https://example.com/alice/plugins/memory-plus/security-audit",
    summary: "No security analysis has been recorded yet.",
  };
  const fetchImpl = mockResponse({
    package: {
      ...remotePlugin,
      ...display,
      compatibility: { minGatewayVersion: ">=2.0.0" },
    },
    owner: { ...owner, image: "https://avatars.example.com/alice.png" },
    versions: {
      items: [
        { ...current, distTags: ["latest"] },
        { ...previous, distTags: [] },
      ],
    },
    version: {
      ...previous,
      pluginManifestSummary: {
        configFields,
        mcpServers,
        ...capabilities,
        uiCapabilities: ui,
        bundledSkills: skills,
        compatibility: { minGatewayVersion: ">=1.0.0" },
      },
      verification: { ...verification, scope: "artifact-only" },
    },
    security: {
      overview: security.summary,
      verdict: security.verdict,
      securityAuditUrl: security.auditUrl,
      trust: {
        scanStatus: "clean",
        moderationState: "approved",
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    },
    readme: "# Memory Plus\n\nLong-term memory.",
  });

  const detail = await fetchClawHubPluginDetail({
    ...registry,
    packageName: "memory-plus",
    version: "1.2.2",
  });

  const url = fetchImpl.url();
  expect(`${url.pathname}${url.search}`).toBe("/api/v1/packages/memory-plus/detail?version=1.2.2");
  expect(detail).toMatchObject({
    packageName: "memory-plus",
    iconUrl: `https://example.com${remotePlugin.icon}`,
    owner: { ...owner, imageUrl: "https://avatars.example.com/alice.png" },
    ...display,
    registry: "https://example.com",
    selectedRelease: { ...previous, tags: [] },
    downloadability: { status: "unknown" },
    metadata: { manifest: "available", readme: "available", security: "available" },
    trust: { disposition: "review-required", pending: false, stale: false },
    readme: "# Memory Plus\n\nLong-term memory.",
    compatibility: { minGatewayVersion: ">=1.0.0" },
    configFields,
    mcpServers: ["memory", "legacy"],
    mcpServerDetails: mcpServers,
    ...capabilities,
    skills,
    versions: [
      { ...current, tags: ["latest"] },
      { ...previous, tags: [] },
    ],
    verification,
    security,
  });
  expect(detail.uiCapabilities).toEqual(expected);
  const joined = joinDetail(detail);
  expect(joined).toMatchObject({
    ...capabilities,
    mcpServers: ["memory", "legacy"],
    mcpServerDetails: mcpServers,
  });
  expect(joined.uiCapabilities).toEqual(expected);
  expect(Value.Check(PluginDiscoveryDetailSchema, joined)).toBe(true);
});

it("withholds unsafe MCP endpoints and only projects bounded public metadata", async () => {
  const credentialEndpoint = new URL("https://example.invalid/mcp");
  credentialEndpoint.username = "test-user";
  credentialEndpoint.password = "test-password";
  const unsafeUrls = [
    "not a URL",
    "javascript:alert(1)",
    "http://mcp.example.com/insecure",
    credentialEndpoint.href,
    "https://mcp.example.com/mcp?token=private-token",
    "https://mcp.example.com/mcp?callback=https%3A%2F%2Fexample.com%2F%3Fkey%3Dprivate-key",
    "https://mcp.example.com/mcp#private-fragment",
    "https://127.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://tools.internal/mcp",
    "https://mcp.example.com:8443/mcp",
  ];
  const detail = await readDetail({
    version: {
      version: "1.2.3",
      createdAt: 100,
      pluginManifestSummary: {
        configFields: [],
        bundledSkills: [],
        mcpServers: [
          ...unsafeUrls.map((url, i) => ({ name: `unsafe-${i}`, url, auth: "api-key" })),
          { name: "withheld", url: "https://mcp.example.com/mcp", endpointRedacted: true },
          {
            name: "local-process",
            transport: "stdio",
            command: "private-command",
            args: ["private-argument"],
            env: { TOKEN: "private-env" },
            headers: { Authorization: "private-header" },
            scope: "s".repeat(1001),
            setup: "d".repeat(2001),
          },
          { name: "unknown", transport: "custom", auth: "custom" },
        ],
      },
    },
  });
  expect(detail.mcpServerDetails).toEqual([
    ...unsafeUrls.map((_, i) => ({
      name: `unsafe-${i}`,
      auth: "api-key",
      endpointRedacted: true,
    })),
    { name: "withheld", endpointRedacted: true },
    {
      name: "local-process",
      transport: "stdio",
      scope: "s".repeat(1000),
      setup: "d".repeat(2000),
    },
    { name: "unknown" },
  ]);
  expect(JSON.stringify(detail)).not.toContain("private-");
  expect(Value.Check(PluginDiscoveryDetailSchema, joinDetail(detail))).toBe(true);
});

it.each([undefined, {}])("keeps unreleased detail with optional security: %s", async (security) => {
  const detail = await readDetail({
    package: {
      ...remotePlugin,
      latestVersion: undefined,
      compatibility: { minGatewayVersion: ">=2.0.0" },
    },
    versions: { items: [] },
    version: null,
    readme: null,
    security,
  });
  expect(detail).toMatchObject({
    packageName: "memory-plus",
    versions: [],
    configFields: [],
    selectedRelease: null,
    downloadability: {
      status: "unavailable",
      reason: "The listing has no selected release.",
    },
    metadata: { manifest: "missing", readme: "missing", security: "missing" },
    compatibility: { minGatewayVersion: ">=2.0.0" },
  });
  expect([detail.readme, detail.security]).toEqual([undefined, undefined]);
});
it.each([
  { blocked: true, securityVersion: "1.0.0", expected: "unavailable" },
  { blocked: false, securityVersion: "1.0.0", expected: "unknown" },
  { blocked: true, securityVersion: "2.0.0", expected: "unknown" },
])(
  "separates download policy from bytes: $expected/$securityVersion",
  async ({ blocked, securityVersion, expected }) => {
    const detail = await readDetail(
      {
        version: { version: "1.0.0", createdAt: 100 },
        security: {
          package: { name: "memory-plus" },
          release: { version: securityVersion },
          overview: "Selected release policy",
          securityAuditUrl: "https://example.com/audit",
          trust: {
            blockedFromDownload: blocked,
            reasons: blocked ? ["scan:malicious"] : [],
            pending: false,
            stale: false,
          },
        },
      },
      "1.0.0",
    );
    expect(detail.selectedRelease?.version).toBe("1.0.0");
    expect(detail.downloadability.status).toBe(expected);
    if (detail.downloadability.status !== "downloadable") {
      expect(detail.downloadability.reason).toBeTruthy();
    }
    expect(detail.metadata.security).toBe(securityVersion === "1.0.0" ? "available" : "missing");
  },
);

it.each([
  { packageName: "@bob/memory-plus", version: "1.0.0" },
  { packageName: "memory-plus", version: "2.0.0" },
])("rejects identity substitution: $packageName/$version", async ({ packageName, version }) => {
  await expect(
    readDetail(
      {
        package: { ...remotePlugin, name: packageName },
        version: { version },
      },
      "1.0.0",
    ),
  ).rejects.toThrow(/identity|requested plugin release/);
});

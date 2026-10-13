import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { PluginDiscoveryDetailSchema } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { joinClawHubPluginDetail } from "../plugins/catalog-discovery.js";
import { jsonResponse, requestUrl } from "../test-helpers/http.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  fetchClawHubPluginCatalog,
  fetchClawHubPluginCategories,
  fetchClawHubPluginOverview,
  fetchClawHubPluginVersionCategories,
  fetchClawHubPluginDetail,
} from "./clawhub-plugin-catalog.js";

const remotePlugin = {
  name: "memory-plus",
  displayName: "Memory Plus",
  family: "code-plugin",
  channel: "community",
  isOfficial: false,
  summary: "Long-term memory",
  ownerHandle: "alice",
  ownerImage: "https://cdn.example.com/alice.png",
  categories: ["memory"],
  latestVersion: "1.2.3",
  runtimeId: "memory-plus",
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

function mockResponse(value: unknown) {
  return vi.fn(async (_input: string | URL | Request) => jsonResponse(value));
}

function requestedUrl(fetchImpl: ReturnType<typeof mockResponse>) {
  return new URL(requestUrl(fetchImpl.mock.calls[0]![0]));
}

describe("ClawHub plugin catalog client", () => {
  it.each([false, true])(
    "replays transient failures only when search cannot record an observation: %s",
    async (disabled) => {
      await withEnvAsync({ CLAWHUB_DISABLE_TELEMETRY: String(disabled) }, async () => {
        const fetchImpl = vi
          .fn(async () => jsonResponse({ results: [{ score: 9, package: remotePlugin }] }))
          .mockRejectedValueOnce(new TypeError("fetch failed"));
        const result = fetchClawHubPluginCatalog({
          baseUrl: "https://example.com",
          query: "memory",
          searchSource: "openclaw-control-ui",
          fetchImpl,
        });
        if (disabled) {
          await expect(result).resolves.toMatchObject({ items: [{ packageName: "memory-plus" }] });
          expect(fetchImpl).toHaveBeenCalledTimes(2);
        } else {
          await expect(result).rejects.toThrow("fetch failed");
          expect(fetchImpl).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it.each([["overview", fetchClawHubPluginOverview]])(
    "omits ambient auth from public %s unless explicitly requested",
    async (_name, read) => {
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
          await read({ fetchImpl });
          await read({ fetchImpl, skipAuth: false });
          await read({ fetchImpl, token: "explicit-test-token" });
          await read({ fetchImpl, baseUrl: "https://private.example/clawhub" });
          await read({ fetchImpl, baseUrl: "https://private.example/clawhub", skipAuth: true });
          for (const key of ["OPENCLAW_CLAWHUB_URL", "CLAWHUB_URL"]) {
            await withEnvAsync({ [key]: "https://private.example/clawhub" }, async () => {
              await read({ fetchImpl });
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
    },
  );

  it("reads the bounded plugin overview in one request", async () => {
    const fetchImpl = mockResponse({
      categories: [remoteCategory],
      items: [
        {
          ...remotePlugin,
          featured: true,
          trending: true,
          featuredRank: 1,
          trendingRank: 0,
        },
      ],
    });

    const result = await fetchClawHubPluginOverview({
      baseUrl: "https://example.com",
      fetchImpl,
    });

    expect(requestedUrl(fetchImpl).pathname).toBe("/api/v1/plugins/overview");
    expect(result.categories).toEqual([remoteCategory]);
    expect(result.items).toEqual([
      expect.objectContaining({
        packageName: "memory-plus",
        iconUrl: `https://example.com${remotePlugin.icon}`,
        featured: true,
        trending: true,
        featuredRank: 1,
        trendingRank: 0,
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retains category priority identities from curated page metadata", async () => {
    const category = {
      ...remoteCategory,
      pinnedPackages: ["@vendor/model"],
    };
    const fetchImpl = mockResponse({ items: [], categories: [category] });
    expect(
      await fetchClawHubPluginCatalog({ intent: "all", category: "models", fetchImpl }),
    ).toEqual({ items: [], categories: [category] });
  });

  it("rejects ambiguous registry category priorities", async () => {
    await expect(
      fetchClawHubPluginCategories({
        fetchImpl: async () =>
          jsonResponse({
            categories: [
              {
                ...remoteCategory,
                pinnedPackages: ["@vendor/model", "@vendor/model"],
              },
            ],
          }),
      }),
    ).rejects.toThrow("duplicate or invalid pinned package");
  });

  it("browses the combined plugin endpoint with an opaque cursor", async () => {
    const fetchImpl = mockResponse({ items: [remotePlugin], nextCursor: "pkgplugins:{opaque}" });

    const result = await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "trending",
      category: "memory",
      cursor: "pkgplugins:{opaque}",
      limit: 12,
      fetchImpl,
    });

    const url = requestedUrl(fetchImpl);
    expect(url.pathname).toBe("/api/v1/plugins");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: "memory",
      cursor: "pkgplugins:{opaque}",
      sort: "trending",
      limit: "12",
    });
    expect(result).toEqual({
      items: [
        {
          packageName: "memory-plus",
          displayName: "Memory Plus",
          family: "code-plugin",
          summary: "Long-term memory",
          ownerHandle: "alice",
          isOfficial: false,
          categories: ["memory"],
          latestVersion: "1.2.3",
          runtimeId: "memory-plus",
          iconUrl: `https://example.com${remotePlugin.icon}`,
          downloads: 42,
          installs: 7,
        },
      ],
      nextCursor: "pkgplugins:{opaque}",
    });
  });

  it("uses plugin search with a publisher icon fallback and no invented pagination", async () => {
    const fetchImpl = mockResponse({
      results: [{ score: 9, package: { ...remotePlugin, icon: null } }],
    });

    const result = await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      query: "memory",
      intent: "official",
      limit: 5,
      fetchImpl,
    });

    const url = requestedUrl(fetchImpl);
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

  it("uses ClawHub's featured filter without overriding its canonical order", async () => {
    const fetchImpl = mockResponse({ items: [remotePlugin] });

    await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "featured",
      limit: 6,
      fetchImpl,
    });

    const url = requestedUrl(fetchImpl);
    expect(url.pathname).toBe("/api/v1/plugins");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      featured: "true",
      limit: "6",
    });
  });

  it("validates and restores canonical category ordering", async () => {
    const fetchImpl = mockResponse({
      categories: [
        remoteCategory,
        {
          ...remoteCategory,
          slug: "channels",
          icon: "message-circle",
          order: 0,
        },
      ],
    });

    const categories = await fetchClawHubPluginCategories({
      baseUrl: "https://example.com",
      fetchImpl,
    });

    expect(categories.map((category) => category.slug)).toEqual(["channels", "models"]);
  });

  it("rejects arbitrary category icon values", async () => {
    const fetchImpl = mockResponse({
      categories: [{ ...remoteCategory, icon: "lucide:wrench" }],
    });

    await expect(
      fetchClawHubPluginCategories({ baseUrl: "https://example.com", fetchImpl }),
    ).rejects.toThrow("invalid icon key");
  });

  it("falls back safely for an unknown bare category icon key", async () => {
    const fetchImpl = mockResponse({
      categories: [{ ...remoteCategory, icon: "new-upstream-icon" }],
    });

    await expect(
      fetchClawHubPluginCategories({ baseUrl: "https://example.com", fetchImpl }),
    ).resolves.toEqual([{ ...remoteCategory, icon: "package" }]);
  });

  it("batch-reads current and legacy categories for exact package versions", async () => {
    const categories = ["memory", "tools"];
    let request: Request | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return jsonResponse({
        packages: [
          { name: "@openclaw/memory", version: "1.2.3", categories },
          { name: "@openclaw/missing", version: "4.5.6", categories: null },
        ],
      });
    });

    const result = await fetchClawHubPluginVersionCategories({
      baseUrl: "https://example.com",
      token: "private-token",
      skipAuth: true,
      packages: [
        { name: "@openclaw/memory", version: "1.2.3" },
        { name: "@openclaw/missing", version: "4.5.6" },
      ],
      fetchImpl,
    });

    expect(request?.method).toBe("POST");
    expect(request?.headers.has("authorization")).toBe(false);
    expect(new URL(request?.url ?? "").pathname).toBe("/api/v1/packages/categories:batch");
    await expect(request?.json()).resolves.toEqual({
      packages: [
        { name: "@openclaw/memory", version: "1.2.3" },
        { name: "@openclaw/missing", version: "4.5.6" },
      ],
    });
    expect(result).toEqual([
      { name: "@openclaw/memory", version: "1.2.3", categories },
      { name: "@openclaw/missing", version: "4.5.6", categories: null },
    ]);
  });

  it.each([{ ui: ["widget", "page", "widget"], expected: ["page", "widget"] }])(
    "reads complete exact-version detail with UI metadata $ui",
    async ({ ui, expected }) => {
      const requestedUrls: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(requestUrl(input));
        requestedUrls.push(`${url.pathname}${url.search}`);
        return jsonResponse({
          package: {
            ...remotePlugin,
            topics: ["Retrieval"],
            tags: { latest: "1.2.3", stable: "1.2.2" },
            createdAt: 100,
            updatedAt: 300,
            compatibility: { minGatewayVersion: ">=2.0.0" },
            scanStatus: "clean",
          },
          owner: {
            handle: "alice",
            displayName: "Alice",
            official: true,
            image: "https://avatars.example.com/alice.png",
          },
          versions: {
            items: [
              {
                version: "1.2.3",
                createdAt: 300,
                changelog: "Current release",
                distTags: ["latest"],
              },
              { version: "1.2.2", createdAt: 200, changelog: "Previous release", distTags: [] },
            ],
            nextCursor: null,
          },
          version: {
            version: "1.2.2",
            createdAt: 200,
            changelog: "Previous release",
            pluginManifestSummary: {
              schemaVersion: 1,
              configFields: [
                { name: "apiKey", description: "Service API key", required: true, sensitive: true },
              ],
              mcpServers: [
                {
                  name: "memory",
                  url: "https://mcp.example.com/memory?mode=read",
                  transport: "streamable-http",
                  auth: "oauth",
                  scope: "memory:read",
                  setup: "Connect your account.",
                },
                { name: "legacy" },
              ],
              contracts: { tools: ["memory_recall"], videoGenerationProviders: ["presenter"] },
              providers: ["memory-model"],
              channels: ["memory-chat"],
              uiCapabilities: ui,
              bundledSkills: [
                {
                  name: "Recall",
                  description: "Recall saved knowledge",
                  rootPath: "skills/recall",
                  skillMdPath: "skills/recall/SKILL.md",
                  sha256: "a".repeat(64),
                  size: 42,
                },
              ],
              compatibility: { minGatewayVersion: ">=1.0.0" },
            },
            verification: {
              tier: "source-linked",
              scope: "artifact-only",
              summary: "Linked to source.",
              sourceRepo: "alice/memory-plus",
              sourceCommit: "abc123",
              sourcePath: "plugins/memory-plus",
              scanStatus: "clean",
            },
            llmAnalysis: {
              status: "clean",
              verdict: "benign",
              summary: "Capabilities match the stated purpose.",
              guidance: "Review the API key before enabling.",
              checkedAt: 400,
            },
          },
          security: {
            overview: "Exact release passed ClawHub security review.",
            verdict: "review",
            securityAuditUrl: "https://example.com/alice/plugins/memory-plus/security-audit",
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
      });

      const detail = await fetchClawHubPluginDetail({
        baseUrl: "https://example.com",
        packageName: "memory-plus",
        version: "1.2.2",
        fetchImpl,
      });

      expect(requestedUrls).toEqual(["/api/v1/packages/memory-plus/detail?version=1.2.2"]);
      expect(detail).toMatchObject({
        packageName: "memory-plus",
        iconUrl: `https://example.com${remotePlugin.icon}`,
        owner: {
          handle: "alice",
          displayName: "Alice",
          imageUrl: "https://avatars.example.com/alice.png",
          official: true,
        },
        topics: ["Retrieval"],
        registry: "https://example.com",
        tags: { latest: "1.2.3", stable: "1.2.2" },
        selectedRelease: {
          version: "1.2.2",
          createdAt: 200,
          changelog: "Previous release",
          tags: [],
        },
        downloadability: { status: "unknown" },
        metadata: { manifest: "available", readme: "available", security: "available" },
        trust: { disposition: "clean", pending: false, stale: false },
        createdAt: 100,
        updatedAt: 300,
        readme: "# Memory Plus\n\nLong-term memory.",
        compatibility: { minGatewayVersion: ">=1.0.0" },
        configFields: [
          { name: "apiKey", description: "Service API key", required: true, sensitive: true },
        ],
        mcpServers: ["memory", "legacy"],
        mcpServerDetails: [
          {
            name: "memory",
            url: "https://mcp.example.com/memory?mode=read",
            transport: "streamable-http",
            auth: "oauth",
            scope: "memory:read",
            setup: "Connect your account.",
          },
          { name: "legacy" },
        ],
        contracts: { tools: ["memory_recall"], videoGenerationProviders: ["presenter"] },
        providers: ["memory-model"],
        channels: ["memory-chat"],
        skills: [{ name: "Recall", description: "Recall saved knowledge" }],
        versions: [
          { version: "1.2.3", createdAt: 300, changelog: "Current release", tags: ["latest"] },
          { version: "1.2.2", createdAt: 200, changelog: "Previous release", tags: [] },
        ],
        verification: {
          tier: "source-linked",
          summary: "Linked to source.",
          sourceRepo: "alice/memory-plus",
          sourceCommit: "abc123",
          sourcePath: "plugins/memory-plus",
          scanStatus: "clean",
        },
        security: {
          status: "clean",
          verdict: "review",
          auditUrl: "https://example.com/alice/plugins/memory-plus/security-audit",
          summary: "Exact release passed ClawHub security review.",
        },
      });
      expect(detail.uiCapabilities).toEqual(expected);
      const joined = joinClawHubPluginDetail({
        remote: detail,
        local: { plugins: [], diagnostics: [], mutationAllowed: true },
      });
      expect(joined.detail).toMatchObject({
        contracts: { tools: ["memory_recall"], videoGenerationProviders: ["presenter"] },
        providers: ["memory-model"],
        channels: ["memory-chat"],
      });
      expect(joined.detail.uiCapabilities).toEqual(expected);
      expect(joined.detail.mcpServers).toEqual(["memory", "legacy"]);
      expect(joined.detail.mcpServerDetails).toEqual(detail.mcpServerDetails);
      expect(Value.Check(PluginDiscoveryDetailSchema, joined.detail)).toBe(true);
    },
  );

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
    const detail = await fetchClawHubPluginDetail({
      packageName: "memory-plus",
      skipAuth: true,
      fetchImpl: mockResponse({
        package: remotePlugin,
        version: {
          version: "1.2.3",
          createdAt: 100,
          pluginManifestSummary: {
            configFields: [],
            bundledSkills: [],
            mcpServers: [
              ...unsafeUrls.map((url, index) => ({
                name: `unsafe-${index}`,
                url,
                auth: "api-key",
              })),
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
        versions: { items: [] },
      }),
    });
    expect(detail.mcpServerDetails).toEqual([
      ...unsafeUrls.map((_, index) => ({
        name: `unsafe-${index}`,
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
    const joined = joinClawHubPluginDetail({
      remote: detail,
      local: { plugins: [], diagnostics: [], mutationAllowed: true },
    });
    expect(Value.Check(PluginDiscoveryDetailSchema, joined.detail)).toBe(true);
  });

  it.each([{}])(
    "keeps detail available without a release or optional security: %s",
    async (security) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          package: {
            ...remotePlugin,
            latestVersion: undefined,
            compatibility: { minGatewayVersion: ">=2.0.0" },
          },
          versions: { items: [] },
          version: null,
          readme: null,
          security,
        }),
      );
      const detail = await fetchClawHubPluginDetail({
        baseUrl: "https://example.com",
        packageName: "memory-plus",
        skipAuth: true,
        fetchImpl,
      });
      expect(detail).toMatchObject({ packageName: "memory-plus", versions: [], configFields: [] });
      expect(detail.selectedRelease).toBeNull();
      expect(detail.downloadability).toEqual({
        status: "unavailable",
        reason: "The listing has no selected release.",
      });
      expect(detail.metadata).toEqual({
        manifest: "missing",
        readme: "missing",
        security: "missing",
      });
      expect(detail.readme).toBeUndefined();
      expect(detail.security).toBeUndefined();
      expect(detail.compatibility).toEqual({ minGatewayVersion: ">=2.0.0" });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { blocked: true, securityVersion: "1.0.0", expected: "unavailable" },
    { blocked: false, securityVersion: "1.0.0", expected: "unknown" },
    { blocked: true, securityVersion: "2.0.0", expected: "unknown" },
  ])(
    "reports release availability without treating policy permission as stored bytes: $expected/$securityVersion",
    async ({ blocked, securityVersion, expected }) => {
      const detail = await fetchClawHubPluginDetail({
        packageName: "memory-plus",
        version: "1.0.0",
        skipAuth: true,
        fetchImpl: mockResponse({
          package: remotePlugin,
          version: { version: "1.0.0", createdAt: 100 },
          versions: { items: [] },
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
        }),
      });
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
  ])(
    "rejects registry identity substitution: $packageName/$version",
    async ({ packageName, version }) => {
      await expect(
        fetchClawHubPluginDetail({
          packageName: "memory-plus",
          version: "1.0.0",
          skipAuth: true,
          fetchImpl: mockResponse({
            package: { ...remotePlugin, name: packageName },
            version: { version },
            versions: { items: [] },
          }),
        }),
      ).rejects.toThrow(/identity|requested plugin release/);
    },
  );
});

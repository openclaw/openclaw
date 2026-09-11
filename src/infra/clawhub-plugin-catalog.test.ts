import { describe, expect, it, vi } from "vitest";
import { jsonResponse, requestUrl } from "../test-helpers/http.js";
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
  categories: ["memory"],
  latestVersion: "1.2.3",
  runtimeId: "memory-plus",
  icon: "https://cdn.example.com/memory-plus.svg",
  stats: { downloads: 42, installs: 7 },
};

describe("ClawHub plugin catalog client", () => {
  it("reads the bounded plugin overview in one request", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({
        categories: [
          {
            slug: "memory",
            label: "Memory",
            description: "Long-term memory.",
            icon: "database",
            order: 0,
          },
        ],
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
    });

    const result = await fetchClawHubPluginOverview({
      baseUrl: "https://example.com",
      fetchImpl,
    });

    expect(new URL(requestedUrl).pathname).toBe("/api/v1/plugins/overview");
    expect(result.categories.map((category) => category.slug)).toEqual(["memory"]);
    expect(result.items).toEqual([
      expect.objectContaining({
        packageName: "memory-plus",
        featured: true,
        trending: true,
        featuredRank: 1,
        trendingRank: 0,
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("browses the combined plugin endpoint with an opaque cursor", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ items: [remotePlugin], nextCursor: "pkgplugins:{opaque}" });
    });

    const result = await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "trending",
      category: "memory",
      cursor: "pkgplugins:{opaque}",
      limit: 12,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
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
          iconUrl: "https://cdn.example.com/memory-plus.svg",
          downloads: 42,
          installs: 7,
        },
      ],
      nextCursor: "pkgplugins:{opaque}",
    });
  });

  it("uses plugin search without inventing pagination", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ results: [{ score: 9, package: remotePlugin }] });
    });

    const result = await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      query: "memory",
      intent: "official",
      limit: 5,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/plugins/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "memory",
      isOfficial: "true",
      limit: "5",
    });
    expect(result.nextCursor).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });

  it("uses ClawHub's featured filter without overriding its canonical order", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ items: [remotePlugin] });
    });

    await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "featured",
      limit: 6,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/plugins");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      featured: "true",
      limit: "6",
    });
  });

  it("requests official plugins first and download order for ordinary browse", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ items: [remotePlugin] });
    });

    await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "all",
      category: "models",
      limit: 8,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: "models",
      officialFirst: "true",
      sort: "downloads",
      limit: "8",
    });
  });

  it("validates and restores canonical category ordering", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categories: [
          {
            slug: "models",
            label: "Models",
            description: "Model providers.",
            icon: "brain",
            order: 1,
          },
          {
            slug: "channels",
            label: "Channels",
            description: "Messaging integrations.",
            icon: "message-circle",
            order: 0,
          },
        ],
      }),
    );

    const categories = await fetchClawHubPluginCategories({
      baseUrl: "https://example.com",
      fetchImpl,
    });

    expect(categories.map((category) => category.slug)).toEqual(["channels", "models"]);
  });

  it.each([
    ["agent-runtimes", "bot"],
    ["integrations", "plug"],
    ["developer-tools", "code-xml"],
    ["infrastructure", "server"],
    ["documents-files", "files"],
    ["inbox-collaboration", "inbox"],
    ["productivity", "list-todo"],
    ["scheduling", "calendar-days"],
    ["finance-payments", "wallet-cards"],
    ["sales-marketing", "megaphone"],
    ["data-analytics", "chart-no-axes-combined"],
    ["agent-orchestration", "workflow"],
    ["research", "search"],
  ])("preserves the registry icon for %s", async (slug, icon) => {
    const category = { slug, label: slug, description: "Plugin category.", icon, order: 0 };
    await expect(
      fetchClawHubPluginCategories({
        baseUrl: "https://example.com",
        fetchImpl: async () => jsonResponse({ categories: [category] }),
      }),
    ).resolves.toEqual([category]);
  });

  it("rejects arbitrary category icon values", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categories: [
          {
            slug: "tools",
            label: "Tools",
            description: "Agent tools.",
            icon: "lucide:wrench",
            order: 0,
          },
        ],
      }),
    );

    await expect(
      fetchClawHubPluginCategories({ baseUrl: "https://example.com", fetchImpl }),
    ).rejects.toThrow("invalid icon key");
  });

  it("falls back safely for an unknown bare category icon key", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categories: [
          {
            slug: "tools",
            label: "Tools",
            description: "Agent tools.",
            icon: "new-upstream-icon",
            order: 0,
          },
        ],
      }),
    );

    await expect(
      fetchClawHubPluginCategories({ baseUrl: "https://example.com", fetchImpl }),
    ).resolves.toEqual([
      {
        slug: "tools",
        label: "Tools",
        description: "Agent tools.",
        icon: "package",
        order: 0,
      },
    ]);
  });

  it.each([
    ["memory", "tools"],
    ["documents-files", "research"],
    ["tools", "runtime", "gateway"],
  ])(
    "batch-reads current and legacy categories for exact package versions: %j",
    async (...categories) => {
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
    },
  );

  it("assembles normalized detail from ClawHub package metadata and release endpoints", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(requestUrl(input));
      requestedUrls.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/versions")) {
        return jsonResponse({
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
        });
      }
      if (url.pathname.endsWith("/versions/1.2.2")) {
        return jsonResponse({
          package: { name: "memory-plus", displayName: "Memory Plus", family: "code-plugin" },
          version: {
            version: "1.2.2",
            createdAt: 200,
            changelog: "Previous release",
            pluginManifestSummary: {
              schemaVersion: 1,
              configFields: [
                { name: "apiKey", description: "Service API key", required: true, sensitive: true },
              ],
              mcpServers: [{ name: "memory" }],
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
        });
      }
      if (url.pathname.endsWith("/versions/1.2.2/security")) {
        return jsonResponse({
          overview: "Exact release passed ClawHub security review.",
          securityAuditUrl: "https://example.com/alice/plugins/memory-plus/security-audit",
          trust: {
            scanStatus: "clean",
            moderationState: "approved",
            blockedFromDownload: false,
            reasons: [],
            pending: false,
            stale: false,
          },
        });
      }
      if (url.pathname.endsWith("/file")) {
        return new Response("# Memory Plus\n\nLong-term memory.", { status: 200 });
      }
      return jsonResponse({
        package: {
          ...remotePlugin,
          topics: ["Retrieval"],
          createdAt: 100,
          updatedAt: 300,
          compatibility: { minGatewayVersion: ">=1.0.0" },
          scanStatus: "clean",
        },
        owner: {
          handle: "alice",
          displayName: "Alice",
          image: "https://avatars.example.com/alice.png",
        },
      });
    });

    const detail = await fetchClawHubPluginDetail({
      baseUrl: "https://example.com",
      packageName: "memory-plus",
      version: "1.2.2",
      fetchImpl,
    });

    expect(requestedUrls[0]).toBe("/api/v1/packages/memory-plus");
    expect(requestedUrls.slice(1).toSorted()).toEqual(
      [
        "/api/v1/packages/memory-plus/versions?limit=10",
        "/api/v1/packages/memory-plus/versions/1.2.2",
        "/api/v1/packages/memory-plus/file?path=README.md&preview=1&version=1.2.2",
        "/api/v1/packages/memory-plus/versions/1.2.2/security",
      ].toSorted(),
    );
    expect(detail).toMatchObject({
      packageName: "memory-plus",
      owner: {
        handle: "alice",
        displayName: "Alice",
        imageUrl: "https://avatars.example.com/alice.png",
      },
      topics: ["Retrieval"],
      createdAt: 100,
      updatedAt: 300,
      readme: "# Memory Plus\n\nLong-term memory.",
      compatibility: { minGatewayVersion: ">=1.0.0" },
      configFields: [
        { name: "apiKey", description: "Service API key", required: true, sensitive: true },
      ],
      mcpServers: ["memory"],
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
        auditUrl: "https://example.com/alice/plugins/memory-plus/security-audit",
        summary: "Exact release passed ClawHub security review.",
      },
    });
  });

  it("keeps plugin detail available when optional security metadata fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.endsWith("/security")) {
        return jsonResponse({});
      }
      if (url.pathname.endsWith("/versions")) {
        return jsonResponse({ items: [] });
      }
      if (url.pathname.endsWith("/versions/1.0.0")) {
        return jsonResponse({ version: { version: "1.0.0" } });
      }
      if (url.pathname.endsWith("/file")) {
        return new Response("", { status: 404 });
      }
      return jsonResponse({
        package: {
          name: "memory-plus",
          displayName: "Memory Plus",
          family: "code-plugin",
          isOfficial: false,
          categories: ["memory"],
          latestVersion: "1.0.0",
        },
      });
    });

    const detail = await fetchClawHubPluginDetail({
      baseUrl: "https://example.com",
      packageName: "memory-plus",
      version: "1.0.0",
      fetchImpl,
    });

    expect(detail.packageName).toBe("memory-plus");
    expect(detail.security).toBeUndefined();
  });
});

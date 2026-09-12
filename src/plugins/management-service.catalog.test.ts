import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinClawHubPluginCatalog } from "./catalog-discovery.js";
import {
  emptyMetadataSnapshot,
  hostedDiffsEntry,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  providerAuthChoices: vi.fn(),
  pluginVersionCategories: vi.fn(),
  recommendedInstalls: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: (...args: unknown[]) => mocks.providerAuthChoices(...args),
}));

vi.mock("../infra/clawhub-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-plugin-catalog.js")>()),
  fetchClawHubPluginVersionCategories: (...args: unknown[]) =>
    mocks.pluginVersionCategories(...args),
}));

vi.mock("./recommended-tool-installs.js", () => ({
  listRecommendedToolInstalls: (...args: unknown[]) => mocks.recommendedInstalls(...args),
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { listManagedPlugins, resolveManagedPluginIconSource, resolveManagedSetupCatalogIconUrl } =
  await import("./management-service.js");

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

describe("managed plugin catalog", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    clearManagedPluginCatalogCache();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.providerAuthChoices.mockReturnValue([]);
    mocks.pluginVersionCategories.mockResolvedValue([]);
    mocks.recommendedInstalls.mockReturnValue([]);
    mockHostedOfficialCatalog([]);
  });

  it("keeps bundled curation when the hosted catalog falls back offline", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "bundled-fallback",
      entries: [hostedDiffsEntry],
      error: "offline",
    });

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        name: "Diffs",
        description: "Hosted description",
        version: "2.0.0",
        featured: true,
        order: 40,
        install: { source: "clawhub", packageName: "@openclaw/diffs" },
      }),
    ]);
  });

  it("normalizes package-shaped hosted rows and deduplicates their runtime id", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);

    const available = await listManagedPlugins({ config: {}, env: {} });
    expect(available.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        name: "Diffs",
        installed: false,
        featured: true,
        order: 40,
        install: { source: "official", pluginId: "diffs" },
      }),
    ]);

    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );
    const installed = await listManagedPlugins({ config: {}, env: {} });
    expect(installed.plugins).toHaveLength(1);
    expect(installed.plugins[0]).toMatchObject({ id: "diffs", installed: true, enabled: true });
  });

  it("projects missing required plugin config as needs setup", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: false,
        id: "needs-config",
        configSchema: {
          type: "object",
          required: ["token"],
          properties: { token: { type: "string" } },
        },
      }),
    );

    const missing = await listManagedPlugins({ config: {}, env: {} });
    expect(missing.plugins[0]).toMatchObject({
      id: "needs-config",
      enabled: false,
      state: "needs-setup",
    });

    const configured = await listManagedPlugins({
      config: {
        plugins: { entries: { "needs-config": { enabled: false, config: { token: "set" } } } },
      },
      env: {},
    });
    expect(configured.plugins[0]).toMatchObject({
      id: "needs-config",
      enabled: false,
      state: "disabled",
    });
  });

  it("does not transfer bundled endorsement to a package identity impostor", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mockHostedOfficialCatalog([
      {
        ...hostedDiffsEntry,
        name: "community/impostor",
        openclaw: {
          ...hostedDiffsEntry.openclaw,
          install: { clawhubSpec: "clawhub:community/impostor", defaultChoice: "clawhub" },
        },
      },
    ]);

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([]);
  });

  it("normalizes hosted catalog hints before building the public DTO", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: {
        entries: [
          {
            name: "community/partial",
            openclaw: {
              plugin: { id: "partial", label: "Partial" },
              catalog: { featured: "yes", order: 25 },
            },
          },
          {
            name: "community/invalid",
            openclaw: {
              plugin: { id: "invalid", label: "Invalid" },
              catalog: { featured: "yes", order: "first" },
            },
          },
        ] as never,
      },
    });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "partial",
        order: 25,
      }),
    ]);
    expect(catalog.plugins[0]).not.toHaveProperty("featured");
  });

  it("lists bundled Workboard as installed, default-off, and cold-disabled", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "workboard",
        packageName: "@openclaw/workboard",
        installed: true,
        enabled: false,
        state: "disabled",
        featured: true,
        order: 10,
      }),
    ]);
    expect(catalog.mutationAllowed).toBe(true);
  });

  const privateRegistry = "https://private.example/clawhub";
  it.each([
    ["foreign registry", "clawhub", `${privateRegistry}/`, undefined, false],
    ["public registry", "clawhub", "https://clawhub.ai/", undefined, true],
    ["custom primary override", "clawhub", `${privateRegistry}/`, privateRegistry, true],
    [
      "custom secondary override",
      "clawhub",
      `${privateRegistry}/`,
      privateRegistry,
      true,
      "CLAWHUB_URL",
    ],
    ["different custom registry", "clawhub", "https://other.example/", privateRegistry, false],
    ["public npm counterpart", "npm", undefined, undefined, true],
    ["public npm counterpart on custom registry", "npm", undefined, privateRegistry, false],
    ["unproven registry", "clawhub", undefined, undefined, false],
  ] as const)(
    "binds remote discovery to the effective registry: %s",
    async (
      _label,
      source,
      clawhubUrl,
      activeRegistry,
      matches,
      registryEnv: "OPENCLAW_CLAWHUB_URL" | "CLAWHUB_URL" = "OPENCLAW_CLAWHUB_URL",
    ) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", undefined);
      vi.stubEnv("CLAWHUB_URL", undefined);
      vi.stubEnv(registryEnv, activeRegistry);
      const packageName = "@openclaw/diffs";
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          enabled: false,
          id: "diffs",
          origin: "global",
          categories: ["tools"],
          installRecord:
            source === "clawhub"
              ? { source, clawhubUrl, clawhubPackage: packageName, version: "1.0.0" }
              : { source, spec: packageName, resolvedName: packageName },
        }),
      );

      const local = await listManagedPlugins({
        config: {},
        env: {},
        officialCatalog: { entries: [] },
      });
      const [entry] = joinClawHubPluginCatalog({
        local,
        remote: [
          {
            packageName,
            displayName: "Remote Diffs",
            family: "code-plugin",
            isOfficial: true,
            categories: ["tools"],
          },
        ],
      });

      expect(local.plugins[0]).toMatchObject({ id: "diffs", installed: true });
      expect(entry?.local).toMatchObject({
        installed: matches,
        action: matches ? "manage" : "install",
      });
      expect(entry?.local.pluginId).toBe(matches ? "diffs" : undefined);
    },
  );

  it("projects package-declared categories without consulting ClawHub", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "memory-tools",
        name: "Memory Tools",
        origin: "global",
        categories: ["memory", "tools"],
        packageVersion: "1.2.3",
        installRecord: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/memory-tools",
          version: "1.2.3",
        },
      }),
    );

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins[0]).toMatchObject({
      clawhubPackage: "@openclaw/memory-tools",
      categories: ["memory", "tools"],
    });
    expect(catalog.plugins[0]).not.toHaveProperty("category");
    expect(mocks.pluginVersionCategories).not.toHaveBeenCalled();
  });

  it("batch-enriches missing categories from the exact installed ClawHub version", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "community-memory",
        name: "Community Memory",
        origin: "global",
        packageVersion: "4.5.6",
        installRecord: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "community/memory",
          version: "4.5.6",
        },
      }),
    );
    mocks.pluginVersionCategories.mockResolvedValue([
      {
        name: "community/memory",
        version: "4.5.6",
        categories: ["memory", "tools"],
      },
    ]);

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    const cached = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(mocks.pluginVersionCategories).toHaveBeenCalledOnce();
    expect(mocks.pluginVersionCategories).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.ai",
      skipAuth: true,
      packages: [{ name: "community/memory", version: "4.5.6" }],
    });
    expect(catalog.plugins[0]).toMatchObject({
      clawhubPackage: "community/memory",
      categories: ["memory", "tools"],
    });
    expect(cached.plugins[0]).toMatchObject({
      categories: ["memory", "tools"],
    });
    expect(catalog.plugins[0]).not.toHaveProperty("category");
    expect(cached.plugins[0]).not.toHaveProperty("category");
  });

  it("preserves the shipped category projection alongside package categories", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "chat-bridge",
        name: "Chat Bridge",
        origin: "global",
        categories: ["channels", "tools"],
        channels: ["chat-bridge"],
      }),
    );

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins[0]).toMatchObject({
      categories: ["channels", "tools"],
      category: "channel",
    });
  });

  it("keeps category enrichment scoped to the installed ClawHub registry", async () => {
    const installedAt = (clawhubUrl: string) =>
      metadataSnapshot({
        enabled: true,
        id: "community-memory",
        name: "Community Memory",
        origin: "global",
        packageVersion: "4.5.6",
        installRecord: {
          source: "clawhub",
          clawhubUrl,
          clawhubPackage: "community/memory",
          version: "4.5.6",
        },
      });
    mocks.pluginVersionCategories.mockImplementation(async ({ baseUrl }: { baseUrl: string }) => [
      {
        name: "community/memory",
        version: "4.5.6",
        categories: [baseUrl.includes("private") ? "tools" : "memory"],
      },
    ]);

    mocks.metadata.mockReturnValue(installedAt("https://private.example/clawhub/"));
    const privateCatalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    mocks.metadata.mockReturnValue(installedAt("https://public.example/"));
    const publicCatalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(mocks.pluginVersionCategories.mock.calls).toEqual([
      [
        {
          baseUrl: "https://private.example/clawhub",
          skipAuth: true,
          packages: [{ name: "community/memory", version: "4.5.6" }],
        },
      ],
      [
        {
          baseUrl: "https://public.example",
          skipAuth: true,
          packages: [{ name: "community/memory", version: "4.5.6" }],
        },
      ],
    ]);
    expect(privateCatalog.plugins[0]?.categories).toEqual(["tools"]);
    expect(publicCatalog.plugins[0]?.categories).toEqual(["memory"]);
  });

  it("keeps installed plugins uncategorized when ClawHub enrichment is unavailable", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "community-tool",
        name: "Community Tool",
        origin: "global",
        packageVersion: "1.0.0",
        installRecord: {
          source: "clawhub",
          clawhubPackage: "community/tool",
          version: "1.0.0",
        },
      }),
    );
    mocks.pluginVersionCategories.mockRejectedValue(new Error("ClawHub offline"));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins[0]).toMatchObject({
      id: "community-tool",
      installed: true,
      enabled: true,
      state: "enabled",
    });
    expect(catalog.plugins[0]).not.toHaveProperty("categories");
    expect(catalog.plugins[0]).not.toHaveProperty("category");
  });

  it.each([
    {
      name: "reports missing dependencies for a bundled plugin distributed outside the root package",
      packageBuild: { bundledDist: false },
      expectsError: true,
    },
    {
      name: "keeps plain bundled plugins free of package-local dependency health",
      packageBuild: undefined,
      expectsError: false,
    },
  ])("$name", async ({ packageBuild, expectsError }) => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        packageBuild,
        packageDependencies: { "missing-runtime": "1.0.0" },
      }),
    );

    const catalog = await listManagedPlugins({
      config: { plugins: { entries: { workboard: { enabled: true } } } },
      env: {},
      officialCatalog: { entries: [] },
    });

    const entry = expectDefined(catalog.plugins[0], "catalog entry");
    if (expectsError) {
      expect(entry.error).toContain("required dependencies are missing: missing-runtime");
    } else {
      expect(entry.error).toBeUndefined();
    }
  });

  it("does not project or resolve installed manifest icon URLs", async () => {
    const icon = "https://cdn.example.test/workboard.svg";
    const config = {
      agents: {
        defaults: { workspace: "~/fallback-workspace" },
        list: [
          { id: "main" },
          { id: "research", default: true, workspace: "~/research-workspace" },
        ],
      },
    };
    const env = { HOME: "/tmp/openclaw-managed-plugin-home" };
    const metadata = metadataSnapshot({ enabled: false });
    const manifest = metadata.byPluginId.get("workboard");
    expect(manifest).toBeDefined();
    if (!manifest) {
      throw new Error("missing workboard manifest fixture");
    }
    metadata.byPluginId.set("workboard", Object.assign(manifest, { icon }));
    mocks.metadata.mockReturnValue(metadata);

    const catalog = await listManagedPlugins({
      config,
      env,
      officialCatalog: { entries: [] },
    });
    const resolved = await resolveManagedPluginIconSource({
      config,
      env,
      pluginId: "workboard",
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "workboard" });
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolved).toBeUndefined();
    expect(mocks.metadata).toHaveBeenNthCalledWith(1, {
      config,
      env,
      workspaceDir: "/tmp/openclaw-managed-plugin-home/research-workspace",
    });
    expect(mocks.metadata).toHaveBeenNthCalledWith(2, {
      config,
      env,
      workspaceDir: "/tmp/openclaw-managed-plugin-home/research-workspace",
    });
  });

  it("does not project or resolve official catalog icon URLs", async () => {
    const icon = "https://cdn.example.test/firecrawl.svg";
    const officialCatalog = {
      entries: [
        {
          name: "@openclaw/firecrawl",
          description: "Web extraction and crawling.",
          openclaw: {
            plugin: { id: "firecrawl", label: "FireCrawl" },
            catalog: { featured: true, order: 60 },
            icon,
          },
        },
      ],
    };
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "firecrawl",
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "firecrawl" });
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(catalog.plugins[0]).not.toHaveProperty("icon");
    expect(resolved).toBeUndefined();
  });

  it("resolves the portable package icon", async () => {
    const iconPath = "/tmp/workboard/assets/icon.png";
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: false,
        iconPath,
        channels: ["workboard-chat"],
      }),
    );

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
    });
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "workboard",
    });

    expect(catalog.plugins[0]).toMatchObject({
      id: "workboard",
      hasIcon: true,
      channelIds: ["workboard-chat"],
    });
    expect(resolved).toEqual({ kind: "file", path: iconPath, rootPath: "/tmp/workboard" });
  });

  it("allows only provider-choice and bundled setup catalog icon URLs", async () => {
    const providerIcon = "https://cdn.example.test/provider.svg";
    const recommendedIcon = "https://cdn.example.test/tool.png";
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.providerAuthChoices.mockReturnValue([{ choiceId: "provider", icon: providerIcon }]);
    mocks.recommendedInstalls.mockReturnValue([{ id: "tool", icon: recommendedIcon }]);
    const resolve = (iconUrl: string) =>
      resolveManagedSetupCatalogIconUrl({ config: {}, env: {}, iconUrl });
    expect(resolve(providerIcon)).toBe(providerIcon);
    expect(resolve(recommendedIcon)).toBe(recommendedIcon);
    expect(resolve("https://untrusted.example/icon.png")).toBeUndefined();
    expect(resolve("http://127.0.0.1/private.png")).toBeUndefined();
    expect(mocks.providerAuthChoices).toHaveBeenCalledWith({
      config: {},
      env: {},
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
  });

  it("omits icon capability when the package has no local icon", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "workboard",
    });

    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolved).toBeUndefined();
  });
});

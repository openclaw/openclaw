import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
const {
  listManagedPlugins,
  resolveManagedPluginIconSources,
  resolveManagedPluginActivityIconSource,
  resolveManagedSetupCatalogIconUrl,
} = await import("./management-service.js");

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const listLocalPlugins = (config: OpenClawConfig = {}) =>
  listManagedPlugins({ config, env: {}, officialCatalog: { entries: [] } });

describe("managed plugin catalog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
  });

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
        clawhubPackage: "@openclaw/diffs",
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

  describe("authored credential validation", () => {
    const secretRef = { source: "store", provider: "default", id: "TEST_PLUGIN_KEY" };
    const configured = (config?: Record<string, unknown>, enabled = true): OpenClawConfig => ({
      plugins: { entries: { "ref-plugin": { enabled, ...(config ? { config } : {}) } } },
    });

    beforeEach(() => {
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          enabled: true,
          id: "ref-plugin",
          configSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: {
                type: "object",
                required: ["source", "provider", "id"],
                properties: {
                  source: { const: "store" },
                  provider: { type: "string" },
                  id: { type: "string" },
                },
              },
            },
          },
        }),
      );
    });

    it.each(["active", "captured"])(
      "validates the %s runtime's authored refs across a catalog await",
      async (mode) => {
        const source = configured({ apiKey: secretRef });
        const runtime = configured({ apiKey: "synthetic-resolved-value" });
        setRuntimeConfigSnapshot(runtime, source);
        const config = mode === "captured" ? captureRuntimeConfig(runtime) : runtime;
        // Captured requests can already predate the current publication on entry.
        if (mode === "captured") {
          setRuntimeConfigSnapshot(configured(), configured());
        }
        mocks.officialCatalog.mockImplementationOnce(async () => {
          setRuntimeConfigSnapshot(configured(), configured({ apiKey: 42 }));
          return { source: "hosted", entries: [] };
        });

        const catalog = await listManagedPlugins({ config, env: {} });

        expect(catalog.plugins[0]).toMatchObject({ id: "ref-plugin", state: "enabled" });
        expect(catalog.plugins[0]).not.toHaveProperty("error");
        expect(runtime.plugins?.entries?.["ref-plugin"]?.config?.apiKey).toBe(
          "synthetic-resolved-value",
        );
        expect(source.plugins?.entries?.["ref-plugin"]?.config?.apiKey).toEqual(secretRef);
      },
    );

    it.each([
      ["invalid authored config", { apiKey: "synthetic-invalid-plaintext" }, "error"],
      ["missing authored config", undefined, "needs-setup"],
    ] as const)("preserves %s", async (_name, authoredConfig, state) => {
      const source = configured(authoredConfig, false);
      const runtime = configured({ apiKey: secretRef }, false);
      setRuntimeConfigSnapshot(runtime, source);

      const catalog = await listManagedPlugins({ config: runtime, env: {} });

      expect(catalog.plugins[0]).toMatchObject({ state });
      if (state === "error") {
        expect(catalog.plugins[0]?.error).toBe("apiKey: must be object");
      }
    });

    it("does not replace an explicit candidate with the active source", async () => {
      setRuntimeConfigSnapshot(
        configured({ apiKey: "synthetic-resolved-value" }),
        configured({ apiKey: secretRef }),
      );
      const candidate = configured({ apiKey: "synthetic-invalid-candidate" });

      const catalog = await listManagedPlugins({ config: candidate, env: {} });

      expect(catalog.plugins[0]).toMatchObject({
        state: "error",
        error: "apiKey: must be object",
      });
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
      const sources = await resolveManagedPluginIconSources({
        config: {},
        env: {},
        pluginId: "diffs",
      });
      const expectedRegistry =
        source === "npm" ? "https://clawhub.ai" : clawhubUrl?.replace(/\/+$/, "");
      expect(sources).toEqual(
        expectedRegistry ? [{ kind: "clawhub", baseUrl: expectedRegistry, packageName }] : [],
      );
      expect(local.plugins[0]?.hasIcon).toBe(expectedRegistry ? true : undefined);
    },
  );

  it.each([
    { enabled: true, contracts: { videoGenerationProviders: ["video"] }, expected: ["media"] },
    { enabled: true, contracts: { imageGenerationProviders: ["image"] }, expected: ["media"] },
    { enabled: true, contracts: { musicGenerationProviders: ["music"] }, expected: ["media"] },
    { enabled: false, contracts: { videoGenerationProviders: ["video"] }, expected: undefined },
    { enabled: true, contracts: { videoGenerationProviders: [] }, expected: undefined },
    { enabled: true, contracts: { speechProviders: ["speech"] }, expected: undefined },
  ])(
    "derives Media discovery only for enabled generation plugins (%j)",
    async ({ enabled, contracts, expected }) => {
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          enabled,
          id: "model-provider",
          categories: ["models"],
          contracts,
        }),
      );
      const catalog = await listManagedPlugins({
        config: { plugins: { entries: { "model-provider": { enabled } } } },
        env: {},
        officialCatalog: { entries: [] },
      });
      const plugin = expectDefined(catalog.plugins[0], "managed model provider");
      expect(plugin.categories).toEqual(["models"]);
      expect(plugin.enabled).toBe(enabled);
      if (expected) {
        expect(plugin).toHaveProperty("capabilityCategories", expected);
      } else {
        expect(plugin).not.toHaveProperty("capabilityCategories");
      }
      expect(mocks.pluginVersionCategories).not.toHaveBeenCalled();
    },
  );

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

    const catalog = await listLocalPlugins();
    const cached = await listLocalPlugins();

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
    const privateCatalog = await listLocalPlugins();
    mocks.metadata.mockReturnValue(installedAt("https://public.example/"));
    const publicCatalog = await listLocalPlugins();

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
    const packageRoot = tempDirs.make("managed-plugin-installed-");
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/community-tool", version: "1.0.0" }),
    );
    const metadata = metadataSnapshot({
      enabled: true,
      id: "community-tool",
      name: "Community Tool",
      origin: "global",
      packageVersion: "1.0.0",
      installRecord: {
        source: "clawhub",
        clawhubPackage: "community/tool",
        version: "1.0.0",
        installPath: packageRoot,
      },
    });
    expectDefined(metadata.index.plugins[0], "installed plugin").rootDir = packageRoot;
    const manifest = expectDefined(metadata.byPluginId.get("community-tool"), "plugin manifest");
    manifest.rootDir = packageRoot;
    manifest.source = path.join(packageRoot, "index.ts");
    manifest.manifestPath = path.join(packageRoot, "openclaw.plugin.json");
    fs.writeFileSync(manifest.source, "export {};\n");
    fs.writeFileSync(manifest.manifestPath, JSON.stringify({ id: manifest.id }));
    mocks.metadata.mockReturnValue(metadata);
    mocks.pluginVersionCategories.mockRejectedValue(new Error("ClawHub offline"));

    const catalog = await listLocalPlugins();

    expect(catalog.plugins[0]).toMatchObject({
      id: "community-tool",
      installed: true,
      enabled: true,
      state: "enabled",
    });
    expect(catalog.plugins[0]).not.toHaveProperty("categories");
    expect(catalog.plugins[0]).not.toHaveProperty("category");
  });

  it("does not project or resolve installed manifest icon URLs", async () => {
    const icon = "https://cdn.example.test/workboard.svg";
    const config = {
      agents: {
        defaults: {
          workspace: "~/fallback-workspace",
          systemAgent: { agentId: "research" },
        },
        entries: { main: {}, research: { workspace: "~/research-workspace" } },
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
    const resolved = await resolveManagedPluginIconSources({
      config,
      env,
      pluginId: "workboard",
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
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolved).toEqual([]);
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
    const resolved = await resolveManagedPluginIconSources({
      config: {},
      env: {},
      pluginId: "firecrawl",
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "firecrawl" });
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(catalog.plugins[0]).not.toHaveProperty("icon");
    expect(resolved).toEqual([]);
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
    const resolved = await resolveManagedPluginIconSources({
      config: {},
      env: {},
      pluginId: "workboard",
    });

    expect(catalog.plugins[0]).toMatchObject({
      id: "workboard",
      hasIcon: true,
      channelIds: ["workboard-chat"],
    });
    expect(resolved).toEqual([{ kind: "file", path: iconPath, rootPath: "/tmp/workboard" }]);
    expect(catalog.plugins[0]).not.toHaveProperty("hasActivityIcon");
    expect(catalog.plugins[0]).not.toHaveProperty("activityIconTools");
    expect(
      await resolveManagedPluginActivityIconSource({ config: {}, env: {}, pluginId: "workboard" }),
    ).toBeUndefined();
  });

  it.each([true, false])(
    "resolves exact tool activity icons with default=%s without exposing paths",
    async (hasDefault) => {
      const activityIconPath = "/tmp/workboard/assets/activity.svg";
      const searchPath = "/tmp/workboard/assets/activity/Task.Search.svg";
      const protoPath = "/tmp/workboard/assets/activity/__proto__.svg";
      const taskPath = "/tmp/workboard/assets/activity/task.svg";
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          enabled: hasDefault,
          activityIconPath: hasDefault ? activityIconPath : undefined,
          toolActivityIconPaths: hasDefault
            ? Object.fromEntries([
                ["__proto__", protoPath],
                ["Task.Search", searchPath],
              ])
            : { task: taskPath },
        }),
      );
      const catalog = await listLocalPlugins();
      expect(catalog.plugins[0]).toMatchObject({
        id: "workboard",
        activityIconTools: hasDefault ? ["Task.Search", "__proto__"] : ["task"],
      });
      if (hasDefault) {
        expect(catalog.plugins[0]).toHaveProperty("hasActivityIcon", true);
      } else {
        expect(catalog.plugins[0]).not.toHaveProperty("hasActivityIcon");
      }
      expect(catalog.plugins[0]).not.toHaveProperty("activityIconPath");
      expect(catalog.plugins[0]).not.toHaveProperty("toolActivityIconPaths");
      expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
      const probes: Array<[string | undefined, string | undefined]> = hasDefault
        ? [
            [undefined, activityIconPath],
            ["Task.Search", searchPath],
            ["task.search", activityIconPath],
            ["__proto__", protoPath],
            ["toString", activityIconPath],
          ]
        : [
            ["task", taskPath],
            [undefined, undefined],
          ];
      for (const [toolName, expectedPath] of probes) {
        expect(
          await resolveManagedPluginActivityIconSource({
            config: {},
            env: {},
            pluginId: "workboard",
            toolName,
          }),
        ).toEqual(
          expectedPath
            ? { kind: "file", path: expectedPath, rootPath: "/tmp/workboard" }
            : undefined,
        );
      }
      expect(
        await resolveManagedPluginActivityIconSource({
          config: {},
          env: {},
          pluginId: "absent",
          toolName: "Task.Search",
        }),
      ).toBeUndefined();
    },
  );

  it("allows only provider-choice and bundled setup catalog icon URLs", async () => {
    const providerIcon = "https://cdn.example.test/provider.svg";
    const recommendedIcon = "https://cdn.example.test/tool.png";
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.providerAuthChoices.mockReturnValue([{ choiceId: "provider", icon: providerIcon }]);
    mocks.recommendedInstalls.mockReturnValue([{ id: "tool", icon: recommendedIcon }]);
    const resolve = (iconUrl: string) =>
      resolveManagedSetupCatalogIconUrl({ config: {}, env: {}, iconUrl });
    expect(resolve(providerIcon)).toBe(providerIcon);
    expect(resolve(`${" ".repeat(2048)}${providerIcon} `)).toBe(providerIcon);
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
});

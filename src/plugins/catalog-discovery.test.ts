import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PluginDiscoveryDetailSchema,
  PluginDiscoveryEntrySchema,
  type PluginCatalogEntry,
  type PluginsInspectResult,
  type PluginsListResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import {
  joinClawHubPluginCatalog,
  joinLocalPluginDetail,
  resolvePluginDiscoveryIdentity,
} from "./catalog-discovery.js";

const remote = {
  packageName: "@alice/memory-plus",
  displayName: "Memory Plus",
  family: "code-plugin" as const,
  isOfficial: false,
  categories: ["memory"],
  runtimeId: "memory-plus",
};

function catalogState(plugins: PluginCatalogEntry[], mutationAllowed = true): PluginsListResult {
  return { plugins, diagnostics: [], mutationAllowed };
}

function installed(overrides: Partial<PluginCatalogEntry>): PluginCatalogEntry {
  return {
    id: "memory-plus",
    name: "Memory Plus",
    installed: true,
    enabled: true,
    state: "enabled",
    ...overrides,
  };
}

describe("plugin discovery identity and local join", () => {
  it.each([
    [false, true],
    [true, true],
    [false, false],
  ])(
    "shows only selected plugin capabilities, not package consent (tools: %s, overview: %s)",
    (includeTools, includeOverview) => {
      const plugin = {
        id: "media-suite",
        name: "Media Suite",
        installed: true,
        enabled: false,
        state: "disabled" as const,
      };
      const tools = includeTools ? ["media_metadata", "media_render"] : [];
      const inspection: PluginsInspectResult = {
        ok: true,
        plugin,
        declared: {
          channels: ["sibling-channel"],
          providers: ["media-models", "sibling-models"],
          tools,
          contracts: [
            "mediaUnderstandingProviders: media-models",
            "speechProviders: speech-a",
            "speechProviders: speech-b:regional",
            "videoGenerationProviders: sibling-video",
            ...(includeTools ? ["tools: media_render"] : []),
          ],
          hooks: [],
          mcpServers: ["supported", "unsupported"],
          cliCommands: [],
          cliBackends: [],
          skills: [],
          dangerousConfigFlags: [],
        },
        ...(includeOverview
          ? {
              overview: {
                capabilities: {
                  providers: ["media-models"],
                  channels: [],
                  ui: ["page", "widget"],
                  contracts: {
                    mediaUnderstandingProviders: ["media-models"],
                    speechProviders: ["speech-a", "speech-b:regional"],
                  },
                },
              },
            }
          : {}),
        components: {
          mapped: [],
          skills: [],
          mcpServers: ["supported"],
          commands: [],
          hooks: [],
          lspServers: [],
          unavailable: { capabilities: [], mcpServers: ["unsupported"], lspServers: [] },
        },
        reviewToken: "media-review",
        grants: {
          hooks: {
            allowPromptInjection: { effective: false },
            allowConversationAccess: { effective: false },
          },
        },
      };

      const { detail } = joinLocalPluginDetail({
        plugin,
        local: catalogState([plugin]),
        inspection,
      });

      expect(detail.contracts).toEqual(
        includeOverview
          ? {
              mediaUnderstandingProviders: ["media-models"],
              speechProviders: ["speech-a", "speech-b:regional"],
              ...(includeTools ? { tools: ["media_metadata", "media_render"] } : {}),
            }
          : undefined,
      );
      expect(detail.providers).toEqual(includeOverview ? ["media-models"] : undefined);
      expect(detail.channels).toBeUndefined();
      expect(detail.uiCapabilities).toEqual(includeOverview ? ["page", "widget"] : undefined);
      expect(detail.mcpServers).toEqual(["supported"]);
      expect(detail.mcpServerDetails).toBeUndefined();
      expect(Value.Check(PluginDiscoveryDetailSchema, detail)).toBe(true);
    },
  );

  it.each([
    { name: "uninstalled", state: undefined, published: true, mutationAllowed: true },
    { name: "recorded package", state: "needs-setup", published: true, mutationAllowed: true },
    { name: "disabled mutations", state: undefined, published: true, mutationAllowed: false },
    {
      name: "installed package omitted from search",
      state: "disabled",
      published: false,
      mutationAllowed: true,
    },
  ] as const)(
    "joins $name with a stable opaque identity",
    ({ state, published, mutationAllowed }) => {
      const items = joinClawHubPluginCatalog({
        remote: published ? [remote] : [],
        local: catalogState(
          state
            ? [
                installed({
                  clawhubPackage: remote.packageName,
                  enabled: false,
                  state,
                  ...(!published ? { origin: "global" } : {}),
                }),
              ]
            : [],
          mutationAllowed,
        ),
        ...(!published
          ? { includeBundledOnly: true, intent: "all" as const, query: "memory" }
          : {}),
      });
      expect(items).toHaveLength(1);
      const [plugin] = items;
      const id = plugin?.id;
      if (!id) {
        throw new Error("Expected the joined catalog fixture to have an opaque id.");
      }

      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id).not.toContain(remote.packageName);
      expect(plugin?.catalog).toMatchObject({
        packageName: remote.packageName,
        name: "Memory Plus",
      });
      expect(Value.Check(PluginDiscoveryEntrySchema, plugin)).toBe(true);
      expect(resolvePluginDiscoveryIdentity(id)).toEqual({
        origin: "clawhub",
        identity: remote.packageName,
      });
      expect(resolvePluginDiscoveryIdentity("@alice/memory-plus")).toBeUndefined();
      expect(plugin?.local).toEqual({
        present: Boolean(state),
        installed: Boolean(state),
        enabled: false,
        state: state ?? "not-installed",
        ...(state ? { pluginId: "memory-plus" } : {}),
        action: state ? "manage" : mutationAllowed ? "install" : "unavailable",
      });
    },
  );

  it.each([
    ["bundled", "@openclaw/calendar-local"],
    ["official", "@acme/calendar-local"],
    ["global", "@openclaw/calendar-local"],
    ["workspace", "@openclaw/calendar-local"],
  ])(
    "derives %s attribution from Gateway provenance, never package name %s",
    (origin, packageName) => {
      const plugin = installed({
        id: "calendar-local",
        name: "Calendar Local",
        packageName,
        origin,
      });
      const inventory = catalogState([plugin]);
      const [item] = joinClawHubPluginCatalog({ remote: [], local: inventory, intent: "all" });
      const official = origin === "bundled";
      expect(item?.catalog.official).toBe(official);
      expect(item?.catalog.author).toBe(official ? "openclaw" : undefined);
      expect(item?.catalog.publishedToClawHub).not.toBe(true);
      expect(joinLocalPluginDetail({ plugin, local: inventory }).detail.author).toEqual(
        official ? { handle: "openclaw", displayName: "OpenClaw", official: true } : undefined,
      );
    },
  );

  it.each([
    ["all", undefined, true, true],
    ["all", undefined, false, false],
    ["official", undefined, true, true],
    ["bundled", undefined, true, true],
    ["featured", undefined, false, true],
    ["official", "page-two", false, true],
    ["all", "page-two", false, false],
  ] as const)(
    "keeps local additions scoped to %s intent and cursor %s",
    (intent, cursor, visible, isInstalled) => {
      const items = joinClawHubPluginCatalog({
        remote: [remote],
        local: catalogState([
          installed({
            id: "calendar-local",
            name: "Calendar Local",
            origin: "bundled",
            installed: isInstalled,
            enabled: isInstalled,
            state: isInstalled ? "enabled" : "not-installed",
          }),
        ]),
        intent,
        includeBundledOnly: intent === "bundled" || intent === "official" || Boolean(cursor),
        cursor,
      });
      expect(items.map((item) => item.catalog.name).toSorted()).toEqual(
        visible ? ["Calendar Local", "Memory Plus"] : ["Memory Plus"],
      );
      if (visible) {
        expect(items.find((item) => item.catalog.name === "Calendar Local")?.catalog).toMatchObject(
          { official: true, author: "openclaw" },
        );
      }
    },
  );

  it("uses the local catalog counterpart to exclude published bundled plugins", () => {
    const expedia = {
      ...remote,
      packageName: "@expediagroup/expedia-openclaw",
      displayName: "Expedia Travel",
      runtimeId: "expedia-travel",
    };
    const local = {
      plugins: [
        {
          id: "expedia-travel",
          packageName: expedia.packageName,
          clawhubPackage: expedia.packageName,
          name: "Expedia Travel",
          origin: "bundled",
          installed: false,
          enabled: false,
          state: "not-installed" as const,
        },
        {
          id: "private-bundle",
          packageName: "@openclaw/private-bundle",
          name: "Private Bundle",
          origin: "bundled",
          installed: false,
          enabled: false,
          state: "not-installed" as const,
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    };

    const items = joinClawHubPluginCatalog({
      remote: [],
      local,
      includeBundledOnly: true,
      intent: "bundled",
    });

    expect(items.map((item) => item.catalog.name)).toEqual(["Private Bundle"]);
  });

  it.each(["bundled", "global"])(
    "preserves derived Media membership through category filtering and hosted pagination (%s)",
    (origin) => {
      const provider = {
        id: "novita",
        name: "Novita",
        packageName: "@openclaw/novita",
        clawhubPackage: "@openclaw/novita",
        origin,
        installed: true,
        enabled: true,
        state: "enabled" as const,
        categories: ["models"],
        capabilityCategories: ["media"],
      };
      const local = { plugins: [provider], diagnostics: [], mutationAllowed: true };
      const options = {
        local,
        intent: "all" as const,
        includeBundledOnly: true,
        category: "media",
        categories: [
          {
            slug: "media",
            label: "Media",
            description: "Media",
            icon: "palette" as const,
            order: 0,
          },
        ],
      };
      const first = joinClawHubPluginCatalog({ ...options, remote: [] });
      expect(first).toHaveLength(1);
      expect(first[0]?.catalog.categories).toEqual(["models", "media"]);
      expect(first[0]?.local).toMatchObject({ enabled: true, action: "manage" });
      const published = {
        ...remote,
        packageName: provider.packageName,
        displayName: "Novita published",
        categories: ["models"],
        downloads: 10,
      };
      const next = joinClawHubPluginCatalog({ ...options, remote: [published], cursor: "next" });
      expect(next).toHaveLength(1);
      expect(next[0]?.id).toBe(first[0]?.id);
      expect(next[0]?.catalog).toMatchObject({ categories: ["models", "media"], downloads: 10 });
      expect(joinClawHubPluginCatalog({ ...options, remote: [published] })).toHaveLength(1);
      expect(joinClawHubPluginCatalog({ ...options, category: "voice", remote: [] })).toEqual([]);
      expect(joinClawHubPluginCatalog({ ...options, query: "novita", remote: [] })).toHaveLength(1);
      const disabled = {
        ...provider,
        enabled: false,
        state: "disabled" as const,
        capabilityCategories: undefined,
      };
      const disabledOptions = { ...options, local: { ...local, plugins: [disabled] } };
      expect(joinClawHubPluginCatalog({ ...disabledOptions, remote: [] })).toEqual([]);
      if (origin === "bundled") {
        const disabledModelsLocal = joinClawHubPluginCatalog({
          ...disabledOptions,
          category: "models",
          remote: [],
        });
        expect(disabledModelsLocal[0]?.catalog.categories).toEqual(["models"]);
      }
      const disabledModels = joinClawHubPluginCatalog({
        ...disabledOptions,
        category: "models",
        remote: [published],
        cursor: "next",
      });
      expect(disabledModels[0]?.catalog.categories).toEqual(["models"]);
      expect(disabledModels[0]?.local).toMatchObject({ enabled: false, action: "manage" });
      expect(provider.categories).toEqual(["models"]);
      expect(published.categories).toEqual(["models"]);
      const legacy = { ...provider, categories: ["models", "tools", "runtime"] };
      const legacyItems = joinClawHubPluginCatalog({
        ...options,
        local: { ...local, plugins: [legacy] },
        remote: [],
      });
      expect(legacyItems[0]?.catalog.categories).toEqual(["models", "tools", "runtime", "media"]);
      expect(Value.Check(PluginDiscoveryEntrySchema, legacyItems[0])).toBe(true);
    },
  );

  it.each(["runtime", "package"])("does not trust an unverified %s namesake", (alias) => {
    const [item] = joinClawHubPluginCatalog({
      remote: [{ ...remote, categories: ["models"] }],
      local: catalogState([
        installed(
          alias === "runtime"
            ? { id: remote.runtimeId, name: "Different package" }
            : {
                id: "namesake",
                name: "Namesake",
                packageName: remote.packageName,
                origin: "workspace",
                categories: ["models"],
                capabilityCategories: ["media"],
              },
        ),
      ]),
    });
    expect(item?.catalog.categories).toEqual(["models"]);
    expect(item?.local.present).toBe(false);
    expect(item?.local).toMatchObject({ installed: false, state: "not-installed" });
  });

  it.each(["enabled", "needs-setup"] as const)(
    "keeps unmatched installed search entries and deduplicates %s remote aliases",
    (state) => {
      const items = joinClawHubPluginCatalog({
        remote: [remote],
        local: catalogState([
          installed({ id: "workspace-memory", name: "Memory Workspace", origin: "workspace" }),
          installed({
            id: "global-memory",
            name: "Memory Sidecar",
            origin: "global",
            enabled: false,
            state: "disabled",
          }),
          installed({
            id: "bundled-memory-plus",
            packageName: remote.packageName,
            clawhubPackage: remote.packageName,
            name: "Bundled presentation",
            origin: "bundled",
            installed: false,
            enabled: false,
            state: "not-installed",
          }),
          installed({
            packageName: remote.packageName,
            clawhubPackage: remote.packageName,
            name: "Memory Remote Local",
            origin: state === "enabled" ? "workspace" : "global",
            enabled: state === "enabled",
            state,
          }),
        ]),
        includeBundledOnly: true,
        intent: "all",
        query: "memory",
      });

      expect(items.map((item) => item.catalog.name)).toEqual([
        "Memory Sidecar",
        "Memory Workspace",
        "Memory Plus",
      ]);
      expect(items[2]?.local).toMatchObject({
        pluginId: "memory-plus",
        state,
        action: "manage",
      });
      expect(items.filter((item) => item.catalog.packageName === remote.packageName)).toHaveLength(
        1,
      );
    },
  );

  it.each([false, true])(
    "sorts browse by downloads with category pinning=%s and ignores local namesakes",
    (pinned) => {
      const bundled = installed({
        id: "bundled-model",
        name: "Bundled Model",
        packageName: "@vendor/model",
        origin: "bundled",
        categories: ["models"],
      });
      const items = joinClawHubPluginCatalog({
        remote: pinned
          ? [{ ...remote, categories: ["models"], downloads: 100_000 }]
          : [
              {
                ...remote,
                packageName: "@openclaw/official-memory",
                displayName: "Official Memory",
                isOfficial: true,
                downloads: 10,
              },
              { ...remote, downloads: 9_000 },
            ],
        local: catalogState(
          pinned
            ? [bundled, { ...bundled, id: "impostor", origin: "workspace" }]
            : [
                installed({
                  id: "workspace-memory",
                  name: "Workspace Memory",
                  origin: "workspace",
                }),
              ],
        ),
        intent: "all",
        category: pinned ? "models" : undefined,
        includeBundledOnly: pinned,
        categories: pinned
          ? [
              {
                slug: "models",
                label: "Models",
                description: "Models",
                icon: "bot",
                order: 0,
                pinnedPackages: ["@vendor/model"],
              },
            ]
          : undefined,
      });
      expect(items.map((item) => item.catalog.name)).toEqual(
        pinned
          ? ["Bundled Model", "Memory Plus"]
          : ["Memory Plus", "Official Memory", "Workspace Memory"],
      );
      if (pinned) {
        expect(items[0]?.catalog.categoryRanks).toEqual({ models: 0 });
      }
    },
  );

  it.each([{ categories: undefined }, { categories: ["tools", "web"] }])(
    "filters bundled search and projects install metadata with categories $categories",
    ({ categories }) => {
      const plugin = {
        id: "calendar-local",
        name: "Memory Calendar",
        description: "Coordinate a local calendar.",
        packageName: "@openclaw/calendar-local",
        installed: false,
        enabled: false,
        state: "not-installed" as const,
        category: "tool",
        categories,
        origin: "bundled",
        install: { source: "official" as const, pluginId: "calendar-local" },
      };
      const common = {
        remote: [remote],
        local: catalogState([plugin]),
        includeBundledOnly: true,
      } as const;

      const matches = joinClawHubPluginCatalog({ ...common, query: "memory" });
      expect(matches.map((item) => item.catalog.name)).toEqual(["Memory Calendar", "Memory Plus"]);
      expect(joinClawHubPluginCatalog({ ...common, remote: [], query: "unrelated" })).toHaveLength(
        0,
      );
      const bundled = joinClawHubPluginCatalog({
        ...common,
        remote: [],
        intent: "bundled",
        category: categories ? "web" : "tool",
      });
      expect(bundled).toHaveLength(1);
      expect(bundled[0]).toMatchObject({
        catalog: {
          packageName: plugin.packageName,
          categories: categories ?? ["tool"],
          official: true,
          author: "openclaw",
          publishedToClawHub: false,
        },
        local: {
          present: true,
          action: "install",
          install: { source: "official", pluginId: "calendar-local" },
        },
      });
      expect(resolvePluginDiscoveryIdentity(bundled[0]?.id ?? "")).toEqual({
        origin: "local",
        identity: "calendar-local",
      });
    },
  );
});

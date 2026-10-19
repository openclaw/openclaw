import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinClawHubPluginCatalog } from "./catalog-discovery.js";
import { managementMetadata as metadataSnapshot } from "./management-service.test-support.js";
import type { OfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  bundledEntries: undefined as OfficialExternalPluginCatalogEntry[] | undefined,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./official-external-plugin-catalog.js")>();
  return {
    ...actual,
    listOfficialExternalPluginCatalogEntries: () =>
      mocks.bundledEntries ?? actual.listOfficialExternalPluginCatalogEntries(),
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
      mocks.officialCatalog(...args),
  };
});

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { listManagedPlugins, resolveManagedPluginIconSources } =
  await import("./management-service.js");

function emptyMetadataSnapshot() {
  return {
    index: { plugins: [], installRecords: {} },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

function hostedCatalog(entries: unknown[]) {
  return {
    source: "hosted",
    entries,
  };
}

function setCatalog(
  local: Parameters<typeof metadataSnapshot>[0] | undefined,
  entries: unknown[] = [],
) {
  mocks.metadata.mockReturnValue(local ? metadataSnapshot(local) : emptyMetadataSnapshot());
  mocks.officialCatalog.mockResolvedValue(hostedCatalog(entries));
}

const list = () => listManagedPlugins({ config: {}, env: {} });
const icons = (pluginId: string) =>
  resolveManagedPluginIconSources({ config: {}, env: {}, pluginId });
function expectOnlyPlugin(
  catalog: Awaited<ReturnType<typeof list>>,
  expected: Record<string, unknown>,
) {
  expect(catalog.plugins).toEqual([expect.objectContaining(expected)]);
}

function hostedFeedEntry({
  packageName,
  title,
  pluginId,
  catalogFeatured,
  order,
  ...fields
}: {
  packageName: string;
  title: string;
  featured?: boolean;
  featuredAt?: number;
  pluginId?: string;
  catalogFeatured?: boolean;
  order?: number;
  description?: string;
  icon?: string;
}) {
  return {
    id: packageName,
    title,
    ...fields,
    state: "available",
    publisher: { id: "openclaw", trust: "official" },
    install: {
      candidates: [
        {
          sourceRef: "public-clawhub",
          package: packageName,
          version: "1.0.0",
          integrity: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
    ...(pluginId
      ? {
          openclaw: {
            plugin: { id: pluginId, label: title },
            catalog: {
              ...(catalogFeatured === undefined ? {} : { featured: catalogFeatured }),
              ...(order === undefined ? {} : { order }),
            },
          },
        }
      : {}),
  };
}

// Composition fixtures preserve array occurrences that the native catalog producer deduplicates.
function compositionEntry(
  id: string,
  install: { clawhubSpec?: string; npmSpec?: string; localPath?: string } = {},
  { order = 7 }: { order?: number } = {},
) {
  return {
    featured: true,
    openclaw: {
      plugin: { id, label: id },
      catalog: { featured: true, order },
      install,
    },
  };
}

const hostedImpostorEntry = hostedFeedEntry({
  packageName: "@community/impostor",
  title: "Impostor",
  featured: false,
  pluginId: "workboard",
  catalogFeatured: false,
});

describe("plugin management Featured authority", () => {
  it.each([
    ["slack", "@openclaw/slack"],
    ["msteams", "@openclaw/msteams"],
    ["amazon-bedrock", "@openclaw/amazon-bedrock-provider"],
  ])(
    "joins the published %s counterpart to its bundled or npm installation",
    async (id, packageName) => {
      for (const origin of ["bundled", "global"] as const) {
        setCatalog(
          {
            id,
            packageName,
            origin,
            ...(origin === "global" ? { installRecord: { source: "npm", spec: packageName } } : {}),
          },
          [hostedFeedEntry({ packageName, title: id })],
        );
        clearManagedPluginCatalogCache();
        const local = await list();
        const items = joinClawHubPluginCatalog({
          local,
          remote: [
            {
              packageName,
              displayName: id,
              ownerHandle: "openclaw",
              family: "code-plugin",
              isOfficial: true,
              categories: [],
            },
          ],
          includeBundledOnly: true,
          intent: "all",
          query: id,
        });
        expect(items).toMatchObject([
          {
            catalog: { packageName, official: true, author: "openclaw" },
            local: { pluginId: id, installed: true, action: "manage" },
          },
        ]);
      }
    },
  );

  beforeEach(() => {
    mocks.bundledEntries = undefined;
    clearManagedPluginCatalogCache();
    mocks.metadata.mockReset();
    mocks.officialCatalog.mockReset();
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([]));
  });

  it("orders live featured packages by when they were featured", async () => {
    const entry = (name: string, title: string, order: number, featuredAt?: number) =>
      hostedFeedEntry({
        packageName: `@openclaw/${name}`,
        title,
        featured: true,
        order,
        featuredAt,
      });
    setCatalog(undefined, [
      entry("older-popular", "Older Popular", 1, 100),
      entry("newest-featured", "Newest Featured", 99, 200),
      entry("legacy-featured", "Legacy Featured", 0),
    ]);

    const catalog = await list();

    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual([
      "@openclaw/newest-featured",
      "@openclaw/older-popular",
      "@openclaw/legacy-featured",
    ]);
    expect(catalog.plugins.map((plugin) => plugin.featuredAt)).toEqual([200, 100, undefined]);
  });

  it.each([
    {
      name: "legacy hosted row without featured",
      local: undefined,
      feed: { packageName: "@openclaw/diffs", title: "Diffs" },
      expected: {
        id: "diffs",
        featured: false,
        install: { source: "official", pluginId: "diffs" },
      },
    },
    {
      name: "stale embedded curation on an unmatched live package",
      local: undefined,
      feed: {
        packageName: "@openclaw/new-tool",
        title: "New Tool",
        featured: false,
        pluginId: "new-tool",
        catalogFeatured: true,
        order: 80,
      },
      expected: { id: "new-tool", featured: false, order: 80 },
    },
    {
      name: "live unfeature overriding an installed manifest",
      local: {
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord: { source: "npm", spec: "@openclaw/diffs" },
      },
      feed: { packageName: "@openclaw/diffs", title: "Diffs", featured: false },
      expected: { id: "diffs", installed: true, featured: false, order: 40 },
    },
  ] satisfies Array<{
    name: string;
    local: Parameters<typeof metadataSnapshot>[0] | undefined;
    feed: Parameters<typeof hostedFeedEntry>[0];
    expected: Record<string, unknown>;
  }>)("uses hosted curation for $name", async ({ local, feed, expected }) => {
    setCatalog(local, [hostedFeedEntry(feed)]);
    expectOnlyPlugin(await list(), expected);
  });

  it("applies hosted curation to the exact published package for bundled FireCrawl", async () => {
    const hostedIcon = "https://cdn.example.test/firecrawl-company.png";
    setCatalog(
      {
        id: "firecrawl",
        name: "firecrawl",
        packageName: "@openclaw/firecrawl-plugin",
        featured: false,
        description: "Optional OpenClaw capability.",
      },
      [
        hostedFeedEntry({
          packageName: "@openclaw/firecrawl-plugin",
          title: "FireCrawl",
          featured: true,
          featuredAt: 1_784_280_000_000,
          pluginId: "firecrawl",
          description: "Crawl, scrape, search, and extract web content with FireCrawl.",
          icon: hostedIcon,
        }),
      ],
    );

    const catalog = await list();
    const resolvedIcon = await icons("firecrawl");

    expectOnlyPlugin(catalog, {
      id: "firecrawl",
      name: "FireCrawl",
      description: "Crawl, scrape, search, and extract web content with FireCrawl.",
      packageName: "@openclaw/firecrawl-plugin",
      featured: true,
      featuredAt: 1_784_280_000_000,
      order: 10,
    });
    expect(catalog.plugins[0]?.hasIcon).toBe(true);
    expect(resolvedIcon).toEqual([
      { kind: "clawhub", baseUrl: "https://clawhub.ai", packageName: "@openclaw/firecrawl-plugin" },
    ]);
  });

  it("does not identify a package-less private bundled plugin by hosted runtime id", async () => {
    setCatalog(
      {
        packageName: null,
        description: "Private local workboard.",
      },
      [
        {
          ...hostedImpostorEntry,
          title: "Hosted impostor",
          description: "Untrusted hosted copy.",
          icon: "https://cdn.example.test/impostor.png",
        },
      ],
    );

    const catalog = await list();
    const resolvedIcon = await icons("workboard");

    expectOnlyPlugin(catalog, {
      id: "workboard",
      name: "Workboard",
      description: "Private local workboard.",
      featured: true,
      order: 10,
    });
    expect(resolvedIcon).toEqual([]);
  });

  it.each([
    {
      id: "diffs",
      name: "Diffs",
      origin: "global" as const,
      installRecord: { source: "npm", spec: "@openclaw/diffs" },
    },
    { id: "published-plugin", name: "Published bundled plugin", origin: "bundled" as const },
  ])(
    "clears local curation when declared catalog counterpart $name is omitted from a live feed",
    async (plugin) => {
      mocks.bundledEntries = [
        compositionEntry(plugin.id, {
          clawhubSpec: `clawhub:@openclaw/${plugin.id}`,
          npmSpec: `@openclaw/${plugin.id}`,
        }),
      ];
      setCatalog(plugin);

      expectOnlyPlugin(await list(), {
        id: plugin.id,
        packageName: `@openclaw/${plugin.id}`,
        clawhubPackage: `@openclaw/${plugin.id}`,
        featured: false,
        order: 10,
      });
    },
  );

  it("preserves npm-only bundled curation outside the hosted producer identity", async () => {
    mocks.bundledEntries = [compositionEntry("acpx", { npmSpec: "@openclaw/acpx" })];
    setCatalog({
      id: "acpx",
      name: "ACP Runtime",
      origin: "global",
      packageName: "@openclaw/acpx",
      installRecord: { source: "npm", spec: "@openclaw/acpx" },
    });

    expectOnlyPlugin(await list(), { id: "acpx", featured: true, order: 10 });
  });

  it("accepts trusted official install provenance without discovered package metadata", async () => {
    setCatalog({
      id: "new-tool",
      name: "New Tool",
      origin: "global",
      packageName: null,
      installRecord: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
        clawhubPackage: "@openclaw/new-tool",
      },
    });

    expectOnlyPlugin(await list(), { id: "new-tool", featured: false, order: 10 });
  });

  it.each([
    ["one dual-source occurrence", "bundled"],
    ["split source occurrences", "remote"],
    ["repeated object occurrence", "remote"],
    ["cloned occurrence", "remote"],
    ["different source", "remote"],
    ["different ClawHub case", "remote"],
  ])("preserves overlay identity for %s", async (mode, expectedId) => {
    const both = { clawhubSpec: "clawhub:@acme/shared", npmSpec: "@acme/shared" };
    const bundled = compositionEntry("bundled", both, { order: 41 });
    const hosted = compositionEntry("remote", both);
    let bundledEntries = [bundled];
    if (mode === "split source occurrences") {
      bundledEntries = [
        compositionEntry("bundled-clawhub", { clawhubSpec: both.clawhubSpec }),
        compositionEntry("bundled-npm", { npmSpec: both.npmSpec }),
      ];
    } else if (mode === "repeated object occurrence") {
      bundledEntries = [bundled, bundled];
    } else if (mode === "cloned occurrence") {
      bundledEntries = [bundled, { ...bundled }];
    } else if (mode === "different source") {
      hosted.openclaw.install = { clawhubSpec: both.clawhubSpec };
      bundled.openclaw.install = { npmSpec: both.npmSpec };
    } else if (mode === "different ClawHub case") {
      hosted.openclaw.install = { clawhubSpec: "clawhub:@acme/Shared" };
      bundled.openclaw.install = { clawhubSpec: both.clawhubSpec };
    }
    mocks.bundledEntries = bundledEntries;
    setCatalog(undefined, [hosted]);

    expectOnlyPlugin(await list(), {
      id: expectedId,
      featured: true,
      order: expectedId === "bundled" ? 41 : 7,
    });
  });

  it.each([
    "one",
    "repeated object",
    "clone",
    "npm source only",
    "dual-source feed",
    "npm namesake",
  ])(
    "preserves installed identity and package suppression for %s hosted occurrence",
    async (mode) => {
      const hostedIcon = "https://cdn.example.test/hosted.png";
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          id: "installed",
          name: "Local",
          packageName: "@acme/installed",
        }),
      );
      mocks.bundledEntries = [
        {
          ...compositionEntry("catalog-runtime", {
            clawhubSpec: "clawhub:@acme/shared",
            npmSpec: "@acme/installed",
          }),
          name: "@acme/installed",
        },
      ];
      const hosted = {
        ...compositionEntry(
          "remote",
          mode === "npm source only" || mode === "npm namesake"
            ? { npmSpec: mode === "npm namesake" ? "@acme/shared" : "@acme/installed" }
            : { clawhubSpec: "clawhub:@acme/shared" },
        ),
        title: "Remote",
        icon: hostedIcon,
        ...(mode === "dual-source feed"
          ? {
              state: "available",
              publisher: { trust: "official" },
              install: {
                candidates: [
                  { sourceRef: "public-npm", package: "@acme/installed" },
                  { sourceRef: "public-clawhub", package: "@acme/shared" },
                ],
              },
            }
          : {}),
      };
      // The declared ClawHub counterpart suppresses duplicates without inventing npm identity.
      const entries =
        mode === "repeated object"
          ? [hosted, hosted]
          : mode === "clone"
            ? [hosted, { ...hosted }]
            : [hosted];
      mocks.officialCatalog.mockResolvedValue(hostedCatalog(entries));

      const catalog = await list();
      const icon = await icons("installed");
      const curated = mode === "one" || mode === "dual-source feed";

      expect(catalog.plugins).toEqual([
        ...(mode === "npm namesake"
          ? [
              expect.objectContaining({
                id: "remote",
                installed: false,
                packageName: "@acme/shared",
              }),
            ]
          : []),
        expect.objectContaining({
          id: "installed",
          installed: true,
          name: curated ? "Remote" : "Local",
          featured: curated,
          hasIcon: true,
        }),
      ]);
      expect(icon).toEqual([
        { kind: "clawhub", baseUrl: "https://clawhub.ai", packageName: "@acme/shared" },
      ]);
    },
  );

  it.each([
    ["first hosted icon", "https://cdn.example.test/first.png", undefined],
    ["first missing icon", undefined, undefined],
    ["normalized manifest fallback", undefined, "https://cdn.example.test/normalized.png"],
  ])("retains normalized first-record selection for %s", async (_mode, firstIcon, fallbackIcon) => {
    const alias = (id: string, name: string, packageName: string) =>
      metadataSnapshot({
        id,
        name,
        packageName,
        origin: "global",
        installRecord: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubChannel: "official",
          clawhubPackage: packageName,
        },
      });
    const first = alias("Alias", "First", "@acme/first");
    const second = alias("ALIAS", "Second", "@acme/second");
    const normalizedManifest = {
      ...first.plugins[0]!,
      id: "alias",
      icon: fallbackIcon,
    };
    mocks.metadata.mockReturnValue({
      ...first,
      index: {
        plugins: [...first.index.plugins, ...second.index.plugins],
        installRecords: { ...first.index.installRecords, ...second.index.installRecords },
      },
      plugins: [...first.plugins, ...second.plugins],
      byPluginId: new Map([
        ...first.byPluginId,
        ...second.byPluginId,
        ["alias", normalizedManifest],
      ]),
      normalizePluginId: (id: string) => id.trim().toLowerCase(),
    });
    const officialCatalog = {
      entries: [
        { ...compositionEntry("first", { clawhubSpec: "clawhub:@acme/first" }), icon: firstIcon },
        {
          ...compositionEntry("second", { clawhubSpec: "clawhub:@acme/second" }),
          icon: "https://cdn.example.test/second.png",
        },
      ],
    };
    const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
    const icon = await icons("ALIAS");

    expect(catalog.plugins).toMatchObject([{ hasIcon: true }, { hasIcon: true }]);
    expect(icon).toEqual([
      { kind: "clawhub", baseUrl: "https://clawhub.ai", packageName: "@acme/first" },
    ]);
  });

  const clawhubSpec = "clawhub:@acme/action";
  const npmSpec = "@acme/action@1.2.3";
  const malformedNpm = { npmSpec: "@acme/action@^1.2.3" };
  const npm = { npmSpec: "@acme/action" };
  const official = { trust: "official" };
  it.each([
    ["unversioned ClawHub", { clawhubSpec }, "clawhub"],
    ["pinned ClawHub", { clawhubSpec: `${clawhubSpec}@1.2.3` }, "official"],
    ["npm", { npmSpec }, "official"],
    ["npm with unversioned ClawHub", { npmSpec, clawhubSpec }, "official"],
    ["local", { localPath: "./plugin" }, "official"],
    ["malformed ClawHub", { clawhubSpec: "clawhub:" }, "official"],
    ["malformed npm selector", malformedNpm, "official"],
    [
      "malformed npm selector with unversioned ClawHub",
      { ...malformedNpm, clawhubSpec },
      "official",
    ],
    ["no install", {}, undefined],
    ["rejected state", npm, undefined, "rejected", official],
    ["rejected publisher", npm, undefined, "available", { trust: "community" }],
    ["incomplete authority", npm, undefined, "available"],
  ] satisfies Array<
    [
      string,
      Parameters<typeof compositionEntry>[1],
      string | undefined,
      string?,
      { trust: string }?,
    ]
  >)(
    "preserves the public install action for %s",
    async (_name, install, source, state?: string, publisher?: { trust: string }) => {
      mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
      const entry = { ...compositionEntry("action", install), state, publisher };

      const catalog = await listManagedPlugins({
        config: {},
        env: {},
        officialCatalog: { entries: [entry] },
      });

      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]?.install).toEqual(
        source === "clawhub"
          ? { source: "clawhub", packageName: "@acme/action" }
          : source === "official"
            ? { source: "official", pluginId: "action" }
            : undefined,
      );
    },
  );
});

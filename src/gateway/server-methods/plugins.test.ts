import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsListResultSchema } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { pluginCatalogId } from "../../plugins/catalog-discovery.js";
import { emptyInstalledPluginComponents } from "../../plugins/installed-plugin-components.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { RespondFn } from "./types.js";

const { managementMocks, searchMock, catalogMocks, readers } = vi.hoisted(() => ({
  managementMocks: { inspect: vi.fn(), list: vi.fn() },
  searchMock: vi.fn(),
  catalogMocks: { browse: vi.fn(), categories: vi.fn(), overview: vi.fn(), detail: vi.fn() },
  readers: { installed: vi.fn(), catalog: vi.fn() },
}));

vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin: (...args: unknown[]) => managementMocks.inspect(...args),
  listManagedPlugins: (...args: unknown[]) => managementMocks.list(...args),
}));

vi.mock("../../plugins/catalog-search.js", () => ({
  searchInstallablePluginPackages: (...args: unknown[]) => searchMock(...args),
}));

vi.mock("../../infra/clawhub-plugin-catalog.js", () => ({
  fetchClawHubPluginCatalog: (...args: unknown[]) => catalogMocks.browse(...args),
  fetchClawHubPluginCategories: (...args: unknown[]) => catalogMocks.categories(...args),
  fetchClawHubPluginOverview: (...args: unknown[]) => catalogMocks.overview(...args),
  fetchClawHubPluginDetail: (...args: unknown[]) => catalogMocks.detail(...args),
}));

const { pluginsHandlers } = await import("./plugins.js");

async function callHandler(
  method: string,
  params: Record<string, unknown>,
  registry = createEmptyPluginRegistry(),
) {
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(pluginsHandlers[method], method);
  await withPluginRuntimeRegistryScope(registry, () =>
    handler({
      params,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}),
      } as never,
      respond,
    }),
  );
  const [ok, response, error] = expectDefined(respond.mock.calls.at(-1), "RPC response");
  return { ok, response, error };
}

async function expectBrowse(params: Record<string, unknown>, response: unknown) {
  expect(await callHandler("plugins.catalog.browse", params)).toMatchObject({ ok: true, response });
}

const workboard = {
  id: "workboard",
  name: "Workboard",
  installed: true,
  enabled: false,
  state: "disabled" as const,
};

function uninstalledPlugin(id: string, name: string) {
  return { id, name, installed: false, enabled: false, state: "not-installed" };
}

const remoteUnavailable =
  "ClawHub is unavailable: service unavailable. Installed plugins remain available.";
function inventory(plugins: unknown[] = [], mutationAllowed = true) {
  const result = { plugins, diagnostics: [], mutationAllowed };
  managementMocks.list.mockResolvedValue(result);
  return result;
}
const memoryBundle = {
  ...uninstalledPlugin("memory-bundle", "Memory Bundle"),
  packageName: "@openclaw/memory-bundle",
  origin: "bundled",
};

describe("plugin management Gateway handlers", () => {
  beforeEach(() => {
    Object.values({ ...managementMocks, ...catalogMocks, searchMock }).forEach((mock) =>
      mock.mockReset(),
    );
  });

  it("returns observed SDK compatibility per plugin without changing runtime state", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      withPluginRuntimePluginScope({ pluginId: "deprecated-sdk-fixture" }, () =>
        warnPluginSdkDeprecation({
          family: "session-store",
          method: "getSessionEntry",
          replacement: "getSessionEntryAsync",
        }),
      );
      inventory([
        {
          ...workboard,
          id: "deprecated-sdk-fixture",
          clawhubPackage: "@openclaw/workboard",
        },
        { ...workboard, id: "local-only" },
      ]);
      const result = await callHandler("plugins.list", {});
      expect(result.ok).toBe(true);
      expect(result.response).toMatchObject({
        plugins: [
          {
            id: "deprecated-sdk-fixture",
            clawhubPackage: "@openclaw/workboard",
            catalogId: "ch_QG9wZW5jbGF3L3dvcmtib2FyZA",
            runtime: { state: "unloaded" },
            compatibilityNotices: [
              {
                code: "deprecated-sdk-api",
                severity: "info",
                removalDate: "2026-12-31",
                apis: [
                  {
                    displayName: "getSessionEntry",
                    replacement: "getSessionEntryAsync",
                    removeAfter: "2026-12-31",
                  },
                ],
              },
            ],
          },
          { id: "local-only", catalogId: "local_bG9jYWwtb25seQ", compatibilityNotices: [] },
        ],
      });
      expect(
        (result.response as { plugins: Array<{ clawhubPackage?: string }> }).plugins[1]
          ?.clawhubPackage,
      ).toBeUndefined();
      expect(Compile(PluginsListResultSchema).Check(result.response)).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps an astral plugin runtime error whole at the report cap", async () => {
    const prefix = "a".repeat(1999);
    inventory([{ ...workboard, id: "broken-plugin", state: "error" }]);
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "broken-plugin",
        status: "error",
        error: `${prefix}\u{1F600}tail`,
      }),
    );
    const result = await callHandler("plugins.list", {}, registry);
    expect(result.ok).toBe(true);
    expect(result.response).toMatchObject({
      plugins: [{ id: "broken-plugin", runtime: { state: "unloaded", error: prefix } }],
    });
  });

  it.each([
    {
      params: { source: "clawhub", packageName: "community/plugin", version: "1.2.3" },
      target: { clawhub: { packageName: "community/plugin", version: "1.2.3" } },
    },
    {
      params: { catalogId: "ch_Y29tbXVuaXR5L3BsdWdpbg", version: "1.2.3" },
      target: { clawhub: { packageName: "community/plugin", version: "1.2.3" } },
    },
    { params: { catalogId: "local_d29ya2JvYXJk" }, target: { pluginId: "workboard" } },
  ])("routes plugin inspection identity $params to its owner", async ({ params, target }) => {
    managementMocks.inspect.mockResolvedValue({ ok: true, plugin: { id: "workboard" } });
    expect((await callHandler("plugins.inspect", params)).ok).toBe(true);
    expect(managementMocks.inspect).toHaveBeenCalledWith({ config: {}, ...target });
  });

  it.each([
    { catalogId: "ch_not-canonical" },
    { catalogId: "local_d29ya2JvYXJk", version: "1.2.3" },
    { pluginId: "workboard", source: "clawhub", packageName: "community/plugin" },
    { source: "clawhub", packageName: "community/plugin", catalogId: "ch_Y29tbXVuaXR5L3BsdWdpbg" },
  ])("rejects invalid or ambiguous plugin inspection identity %j", async (params) => {
    const result = await callHandler("plugins.inspect", params);

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(managementMocks.inspect).not.toHaveBeenCalled();
  });

  it("returns local inspection without waiting for optional ClawHub presentation", async () => {
    const inspection = {
      ok: true,
      reviewToken: "a".repeat(64),
      plugin: { id: "community-plugin", installed: true },
      source: { kind: "clawhub", packageName: "community/plugin" },
    } as const;
    managementMocks.inspect.mockResolvedValue(inspection);
    catalogMocks.detail.mockImplementation(() => new Promise(() => {}));

    const result = await callHandler("plugins.inspect", { pluginId: "community-plugin" });

    expect(catalogMocks.detail).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      response: { ...inspection, decisions: [] },
      error: undefined,
    });
  });

  it.each([
    {
      label: "public plugin fields and valid download stats",
      score: 0.91,
      query: { query: "diff", limit: 12 },
      expected: {
        name: "@openclaw/diffs",
        displayName: "Diffs",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        summary: "Readable diffs",
        latestVersion: "1.2.3",
        runtimeId: "diffs",
        verificationTier: "source-linked",
        downloads: 149263,
      },
      stats: { downloads: 149263, installs: 280, stars: 0, versions: 83 },
    },
    {
      label: "malformed download stats",
      score: 0.5,
      query: { query: "demo" },
      expected: {
        name: "community/demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
      },
      stats: { downloads: Number.NaN },
    },
  ])("maps $label to the public DTO", async ({ score, query, expected, stats }) => {
    const { downloads: _downloads, ...fields } = expected;
    searchMock.mockResolvedValue([
      { score, package: { ...fields, ownerHandle: "openclaw", stats } },
    ]);
    expect((await callHandler("plugins.search", query)).response).toEqual({
      results: [{ score, package: expected }],
    });
    expect(searchMock).toHaveBeenCalledWith({ query: query.query, limit: query.limit });
  });

  it("rejects search cursors before contacting ClawHub", async () => {
    const result = await callHandler("plugins.catalog.browse", {
      query: "memory",
      cursor: "browse-only",
    });

    expect(catalogMocks.browse).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Plugin search does not accept a browse cursor.",
    });
  });

  it.each([{}, { query: "memory" }])(
    "starts remote discovery while inventory is pending: %j",
    async (params) => {
      const pendingInventory = Promise.withResolvers<ReturnType<typeof inventory>>();
      managementMocks.list.mockReturnValue(pendingInventory.promise);
      catalogMocks.overview.mockResolvedValue({ items: [], categories: [] });
      catalogMocks.browse.mockResolvedValue({ items: [] });
      const request = callHandler("plugins.catalog.browse", params);
      try {
        expect(
          catalogMocks.overview.mock.calls.length + catalogMocks.browse.mock.calls.length,
        ).toBe(1);
      } finally {
        pendingInventory.resolve({ plugins: [workboard], diagnostics: [], mutationAllowed: true });
        await request;
      }
      expect(await request).toMatchObject({ ok: true });
    },
  );

  it("reports inventory failure without waiting for the observed remote request", async () => {
    const remote = Promise.withResolvers<{ items: [] }>();
    catalogMocks.overview.mockReturnValue(remote.promise);
    managementMocks.list.mockRejectedValue(new Error("inventory unavailable"));
    const result = await callHandler("plugins.catalog.browse", {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: expect.stringContaining("inventory unavailable") },
    });
    expect(catalogMocks.overview).toHaveBeenCalledOnce();
    remote.reject(new Error("remote also failed"));
    await Promise.resolve();
  });

  it("returns canonical ClawHub categories unchanged", async () => {
    const categories = [
      {
        slug: "channels",
        label: "Channels",
        description: "Messaging integrations.",
        icon: "message-circle",
        order: 0,
      },
    ];
    catalogMocks.categories.mockResolvedValue(categories);

    const result = await callHandler("plugins.catalog.categories", {});

    expect(result).toEqual({ ok: true, response: { categories }, error: undefined });
  });

  it("resolves opaque discovery identity for detail reads", async () => {
    catalogMocks.detail.mockResolvedValue({
      packageName: "memory-plus",
      displayName: "Memory Plus",
      family: "code-plugin",
      isOfficial: false,
      categories: ["memory"],
      topics: ["retrieval"],
      versions: [{ version: "1.0.0", createdAt: 100, changelog: "", tags: ["latest"] }],
    });
    inventory([], false);

    const result = await callHandler("plugins.catalog.get", {
      id: "ch_bWVtb3J5LXBsdXM",
      version: "1.0.0",
    });

    expect(catalogMocks.detail).toHaveBeenCalledWith({
      packageName: "memory-plus",
      version: "1.0.0",
    });
    expect(result.response).toMatchObject({
      plugin: {
        id: "ch_bWVtb3J5LXBsdXM",
        local: { present: false, action: "unavailable" },
      },
      detail: {
        origin: "clawhub",
        packageName: "memory-plus",
        topics: ["retrieval"],
        versions: [{ version: "1.0.0" }],
      },
    });
  });

  it.each(["packageName", "clawhubPackage"])(
    "uses only proven ClawHub identity for offline detail: %s",
    async (identityField) => {
      const matches = identityField === "clawhubPackage";
      inventory([{ ...workboard, [identityField]: "memory-plus" }]);
      managementMocks.inspect.mockResolvedValue({
        declared: {
          tools: ["workboard_read"],
          providers: [],
          channels: [],
          mcpServers: ["workboard", "unsupported"],
          skills: ["Local planning"],
        },
        components: {
          ...emptyInstalledPluginComponents(),
          skills: ["Local planning"],
          mcpServers: ["workboard"],
        },
      });
      catalogMocks.detail.mockRejectedValue(new Error("ClawHub offline"));

      const result = await callHandler("plugins.catalog.get", {
        id: "ch_bWVtb3J5LXBsdXM",
        version: "2.0.0",
      });

      expect(result.ok).toBe(matches);
      if (matches) {
        expect(result.response).toMatchObject({
          plugin: {
            id: "ch_bWVtb3J5LXBsdXM",
            catalog: { packageName: "memory-plus" },
            local: { pluginId: "workboard", installed: true, action: "manage" },
          },
          detail: {
            origin: "local",
            packageName: "memory-plus",
            requestedVersion: "2.0.0",
            selectedRelease: null,
            downloadability: { status: "unknown" },
            remoteError: expect.stringContaining("ClawHub offline"),
            registry: expect.any(String),
            contracts: { tools: ["workboard_read"] },
            mcpServers: ["workboard"],
            skills: [{ name: "Local planning" }],
          },
        });
      } else {
        expect(result.response).toBeUndefined();
        expect(result.error).toMatchObject({ code: "UNAVAILABLE" });
        expect(managementMocks.inspect).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects selecting a remote release from a local catalog identity", async () => {
    const result = await callHandler("plugins.catalog.get", {
      id: "local_d29ya2JvYXJk",
      version: "1.2.3",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(managementMocks.list).not.toHaveBeenCalled();
  });

  it("keeps enabled Media membership through browse pages and registry failure", async () => {
    const provider = {
      id: "novita",
      name: "Novita",
      packageName: "@openclaw/novita",
      clawhubPackage: "@openclaw/novita",
      origin: "bundled",
      installed: true,
      enabled: true,
      state: "enabled",
      categories: ["models"],
      capabilityCategories: ["media"],
    };
    inventory([provider]);
    catalogMocks.browse.mockResolvedValueOnce({ items: [], nextCursor: "media-next" });
    const expectedItem = {
      catalog: { categories: ["models", "media"] },
      local: { pluginId: "novita", enabled: true, action: "manage" },
    };
    const media = { category: "media" };
    const expectedPage = { items: [expectedItem] };
    await expectBrowse(media, { ...expectedPage, nextCursor: "media-next" });
    catalogMocks.browse.mockResolvedValueOnce({
      items: [
        {
          packageName: provider.packageName,
          displayName: provider.name,
          family: "code-plugin",
          isOfficial: true,
          categories: ["models"],
          downloads: 123,
        },
      ],
    });
    await expectBrowse(
      { category: "media", cursor: "media-next" },
      {
        items: [{ ...expectedItem, catalog: { ...expectedItem.catalog, downloads: 123 } }],
      },
    );
    expect(catalogMocks.browse).toHaveBeenNthCalledWith(2, {
      query: undefined,
      intent: "all",
      category: "media",
      cursor: "media-next",
      limit: 20,
    });
    catalogMocks.browse.mockRejectedValueOnce(new Error("service unavailable"));
    await expectBrowse(media, { ...expectedPage, remoteError: remoteUnavailable });
    inventory([
      { ...provider, enabled: false, state: "disabled", capabilityCategories: undefined },
    ]);
    catalogMocks.browse.mockResolvedValueOnce({ items: [] });
    await expectBrowse(media, { items: [] });
    catalogMocks.browse.mockResolvedValueOnce({ items: [] });
    await expectBrowse(
      { category: "models" },
      {
        items: [{ catalog: { categories: ["models"] }, local: { enabled: false } }],
      },
    );
    expect(managementMocks.inspect).not.toHaveBeenCalled();
  });

  it("preserves a failed browse cursor so the same page remains retryable", async () => {
    catalogMocks.browse.mockRejectedValue(new Error("service unavailable"));
    inventory();

    const result = await callHandler("plugins.catalog.browse", {
      intent: "all",
      cursor: "page-two",
    });

    expect(result.response).toMatchObject({
      items: [],
      nextCursor: "page-two",
      remoteError: remoteUnavailable,
    });
  });

  it.each([
    { intent: "all", searchSource: undefined },
    { intent: "all", searchSource: "openclaw-control-ui" },
    { intent: "bundled", searchSource: undefined },
  ])(
    "keeps local results private in $intent search with attribution $searchSource",
    async ({ intent, searchSource }) => {
      const remote = {
        packageName: "@alice/memory-plus",
        displayName: "Memory Plus",
        family: "code-plugin" as const,
        isOfficial: false,
        categories: ["memory"],
        runtimeId: "memory-plus",
      };
      catalogMocks.browse.mockResolvedValue({ items: [remote] });
      inventory([memoryBundle]);

      const query = {
        query: "memory",
        intent,
        ...(searchSource ? { searchSource } : {}),
      };
      const result = await callHandler("plugins.catalog.browse", { ...query, pageSize: 25 });

      if (intent === "bundled") {
        expect(catalogMocks.browse).not.toHaveBeenCalled();
      } else {
        expect(catalogMocks.browse).toHaveBeenCalledWith({
          ...query,
          category: undefined,
          cursor: undefined,
          limit: 25,
        });
      }
      expect(result.response).toMatchObject({
        items: [
          { catalog: { name: "Memory Bundle", publishedToClawHub: false } },
          ...(intent === "bundled"
            ? []
            : [{ catalog: { name: "Memory Plus", publishedToClawHub: true } }]),
        ],
      });
    },
  );

  it("resolves and inspects an uninstalled official discovery candidate locally", async () => {
    const localOnly = {
      ...uninstalledPlugin("workboard", "Workboard"),
      packageName: "@openclaw/workboard",
      origin: "official" as const,
      categories: ["tools"],
      install: { source: "official" as const, pluginId: "workboard" },
    };
    inventory([
      localOnly,
      {
        ...uninstalledPlugin("other-plugin", "Alias collision"),
        packageName: "workboard",
      },
    ]);
    managementMocks.inspect.mockResolvedValue({
      overview: {
        capabilities: {
          channels: ["workboard-chat"],
          providers: ["workboard-models"],
          contracts: {},
        },
      },
      declared: {
        tools: ["workboard_read"],
        mcpServers: ["workboard"],
        skills: ["Workboard planning"],
      },
      components: emptyInstalledPluginComponents(),
    });

    const result = await callHandler("plugins.catalog.get", {
      id: "local_d29ya2JvYXJk",
    });

    expect(catalogMocks.detail).not.toHaveBeenCalled();
    expect(managementMocks.inspect).toHaveBeenCalledWith({
      config: {},
      pluginId: "workboard",
    });
    expect(result.response).toMatchObject({
      plugin: {
        catalog: { name: "Workboard", categories: ["tools"], official: false },
        local: {
          state: "not-installed",
          action: "install",
          install: { source: "official", pluginId: "workboard" },
        },
      },
      detail: {
        origin: "local",
        contracts: { tools: ["workboard_read"] },
        channels: ["workboard-chat"],
        providers: ["workboard-models"],
        packageName: "@openclaw/workboard",
        mcpServers: [],
        skills: [],
      },
    });
  });
});

// mock-isolation: Skill reads stay inside this RPC boundary fixture.
vi.mock("../../plugins/management-skill-read.js", () => ({
  readManagedPluginSkill: readers.installed,
}));
// mock-isolation: Catalog reads never contact ClawHub in this RPC fixture.
vi.mock("../../infra/clawhub-plugin-skills.js", () => ({
  fetchClawHubPluginSkill: readers.catalog,
}));

describe("plugin skill read Gateway boundary", () => {
  const catalogSkill = {
    source: "catalog",
    catalogId: pluginCatalogId({ id: "example", clawhubPackage: "@example/plugin" }),
    version: "1.0.0",
    skillName: "guide",
  };
  const { version: _version, ...unversionedSkill } = catalogSkill;
  it.each(["installed", "catalog"])(
    "routes %s reads through the declared owner and returns the full bundle",
    async (source) => {
      const bundle = {
        name: "guide",
        rootPath: "skills/guide",
        entryPath: "SKILL.md",
        files: [{ path: "SKILL.md", status: "ready", content: "Full instructions", sizeBytes: 17 }],
        directories: [],
        inventoryComplete: true,
      };
      readers.installed.mockResolvedValue(bundle);
      readers.catalog.mockResolvedValue(bundle);
      const result = await callHandler(
        "plugins.skills.read",
        source === "installed" ? { source, pluginId: "example", skillName: "guide" } : catalogSkill,
      );
      expect(result).toEqual({ ok: true, response: bundle, error: undefined });
      if (source === "catalog") {
        expect(readers.catalog).toHaveBeenLastCalledWith({
          packageName: "@example/plugin",
          version: "1.0.0",
          skillName: "guide",
        });
      }
    },
  );
  it.each([
    { ...catalogSkill, catalogId: "invalid" },
    unversionedSkill,
    { source: "installed", pluginId: "example", skillName: "guide", path: "/private" },
  ])("rejects invalid source/path requests", async (params) => {
    expect(await callHandler("plugins.skills.read", params)).toEqual({
      ok: false,
      response: undefined,
      error: expect.objectContaining({ code: "INVALID_REQUEST" }),
    });
  });
});

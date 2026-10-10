// Plugin management read tests cover inventory, inspection, and catalog DTOs.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePluginDiscoveryId } from "../../plugins/catalog-discovery.js";
import { emptyInstalledPluginComponents } from "../../plugins/installed-plugin-components.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./types.js";

const managementMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  list: vi.fn(),
}));
const searchMock = vi.hoisted(() => vi.fn());

const catalogMocks = vi.hoisted(() => ({
  browse: vi.fn(),
  categories: vi.fn(),
  overview: vi.fn(),
  detail: vi.fn(),
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
  runtimeConfig: Record<string, unknown> = {},
) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
    expectDefined(
      pluginsHandlers[method],
      "pluginsHandlers[method] test invariant",
    )({
      params,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => runtimeConfig,
      } as never,
      respond: (success, result, requestError) => {
        ok = success;
        response = result;
        error = requestError;
      },
    }),
  );
  return { ok, response, error };
}

const workboard = {
  id: "workboard",
  name: "Workboard",
  installed: true,
  enabled: false,
  state: "disabled" as const,
  featured: true,
  order: 10,
};

const reviewToken = "a".repeat(64);

describe("plugin management Gateway handlers", () => {
  beforeEach(() => {
    managementMocks.inspect.mockReset();
    managementMocks.list.mockReset();
    searchMock.mockReset();
    catalogMocks.browse.mockReset();
    catalogMocks.categories.mockReset();
    catalogMocks.overview.mockReset();
    catalogMocks.detail.mockReset();
  });

  it("projects opaque local identities without inventing ClawHub publication", async () => {
    managementMocks.list.mockResolvedValue({
      plugins: [
        { ...workboard, clawhubPackage: "@openclaw/workboard" },
        {
          id: "diffs",
          name: "Diffs",
          installed: false,
          enabled: false,
          state: "not-installed",
          clawhubPackage: "@openclaw/diffs",
        },
        { ...workboard, id: "local-only", name: "Local only" },
      ],
      diagnostics: [],
      mutationAllowed: true,
    });

    const result = await callHandler("plugins.list", {});

    expect(result.response).toMatchObject({
      plugins: [
        { clawhubPackage: "@openclaw/workboard", catalogId: "ch_QG9wZW5jbGF3L3dvcmtib2FyZA" },
        { clawhubPackage: "@openclaw/diffs", catalogId: "ch_QG9wZW5jbGF3L2RpZmZz" },
        { id: "local-only", catalogId: "local_bG9jYWwtb25seQ" },
      ],
    });
    expect(
      (result.response as { plugins: Array<{ clawhubPackage?: string }> }).plugins[2]
        ?.clawhubPackage,
    ).toBeUndefined();
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
    const inspection = { ok: true, plugin: { id: "workboard", installed: false, enabled: false } };
    managementMocks.inspect.mockResolvedValue(inspection);

    const result = await callHandler("plugins.inspect", params);

    expect(result.ok).toBe(true);
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
      reviewToken,
      plugin: {
        id: "community-plugin",
        name: "Community Plugin",
        version: "1.2.3",
        origin: "global",
        installed: true,
        enabled: false,
      },
      source: { kind: "clawhub", packageName: "community/plugin" },
      declared: {
        channels: [],
        providers: [],
        tools: [],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      components: emptyInstalledPluginComponents(),
      grants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
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

  it("maps plugin-only ClawHub search results to the public DTO", async () => {
    searchMock.mockResolvedValue([
      {
        score: 0.91,
        package: {
          name: "@openclaw/diffs",
          displayName: "Diffs",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          summary: "Readable diffs",
          latestVersion: "1.2.3",
          runtimeId: "diffs",
          ownerHandle: "openclaw",
          verificationTier: "source-linked",
          stats: { downloads: 149263, installs: 280, stars: 0, versions: 83 },
        },
      },
    ]);

    const result = await callHandler("plugins.search", { query: "diff", limit: 12 });

    expect(searchMock).toHaveBeenCalledWith({ query: "diff", limit: 12 });
    expect(result.response).toEqual({
      results: [
        {
          score: 0.91,
          package: {
            name: "@openclaw/diffs",
            displayName: "Diffs",
            family: "code-plugin",
            channel: "official",
            isOfficial: true,
            summary: "Readable diffs",
            latestVersion: "1.2.3",
            runtimeId: "diffs",
            downloads: 149263,
            verificationTier: "source-linked",
          },
        },
      ],
    });
  });

  it("omits malformed ClawHub download stats from the public DTO", async () => {
    searchMock.mockResolvedValue([
      {
        score: 0.5,
        package: {
          name: "community/demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "community",
          isOfficial: false,
          stats: { downloads: Number.NaN },
        },
      },
    ]);

    const result = await callHandler("plugins.search", { query: "demo" });

    expect(result.response).toEqual({
      results: [
        {
          score: 0.5,
          package: {
            name: "community/demo",
            displayName: "Demo",
            family: "code-plugin",
            channel: "community",
            isOfficial: false,
          },
        },
      ],
    });
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
      const inventory = Promise.withResolvers<{
        plugins: (typeof workboard)[];
        diagnostics: [];
        mutationAllowed: boolean;
      }>();
      managementMocks.list.mockReturnValue(inventory.promise);
      catalogMocks.overview.mockResolvedValue({ items: [], categories: [] });
      catalogMocks.browse.mockResolvedValue({ items: [] });
      const request = callHandler("plugins.catalog.browse", params);
      try {
        expect(
          catalogMocks.overview.mock.calls.length + catalogMocks.browse.mock.calls.length,
        ).toBe(1);
      } finally {
        inventory.resolve({ plugins: [workboard], diagnostics: [], mutationAllowed: true });
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
      configFields: [],
      mcpServers: [],
      skills: [],
      versions: [{ version: "1.0.0", createdAt: 100, changelog: "", tags: ["latest"] }],
    });
    managementMocks.list.mockResolvedValue({
      plugins: [],
      diagnostics: [],
      mutationAllowed: false,
    });

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

  it.each([
    {
      label: "package-name alias",
      plugin: { ...workboard, packageName: "memory-plus" },
      matches: false,
    },
    {
      label: "proven counterpart",
      plugin: { ...workboard, clawhubPackage: "memory-plus" },
      matches: true,
    },
  ])(
    "uses only proven ClawHub identity for offline detail: $label",
    async ({ plugin, matches }) => {
      managementMocks.list.mockResolvedValue({
        plugins: [plugin],
        diagnostics: [],
        mutationAllowed: true,
      });
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
          mapped: ["skills", "mcpServers"],
          skills: ["Local planning"],
          mcpServers: ["workboard"],
          unavailable: { capabilities: [], mcpServers: ["unsupported"], lspServers: [] },
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
    managementMocks.list.mockResolvedValue({
      plugins: [provider],
      diagnostics: [],
      mutationAllowed: true,
    });
    catalogMocks.browse.mockResolvedValueOnce({ items: [], nextCursor: "media-next" });
    const first = await callHandler("plugins.catalog.browse", { category: "media" });
    const expectedItem = {
      catalog: { categories: ["models", "media"] },
      local: { pluginId: "novita", enabled: true, action: "manage" },
    };
    expect(first).toMatchObject({
      ok: true,
      response: { items: [expectedItem], nextCursor: "media-next" },
    });
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
    const second = await callHandler("plugins.catalog.browse", {
      category: "media",
      cursor: "media-next",
    });
    expect(second).toMatchObject({
      ok: true,
      response: {
        items: [
          {
            ...expectedItem,
            catalog: { ...expectedItem.catalog, downloads: 123 },
          },
        ],
      },
    });
    expect(catalogMocks.browse).toHaveBeenNthCalledWith(2, {
      query: undefined,
      intent: "all",
      category: "media",
      cursor: "media-next",
      limit: 20,
    });
    catalogMocks.browse.mockRejectedValueOnce(new Error("service unavailable"));
    const offline = await callHandler("plugins.catalog.browse", { category: "media" });
    expect(offline).toMatchObject({
      ok: true,
      response: {
        items: [expectedItem],
        remoteError:
          "ClawHub is unavailable: service unavailable. Installed plugins remain available.",
      },
    });
    managementMocks.list.mockResolvedValue({
      plugins: [
        { ...provider, enabled: false, state: "disabled", capabilityCategories: undefined },
      ],
      diagnostics: [],
      mutationAllowed: true,
    });
    catalogMocks.browse.mockResolvedValueOnce({ items: [] });
    const disabledMedia = await callHandler("plugins.catalog.browse", { category: "media" });
    expect(disabledMedia).toMatchObject({ ok: true, response: { items: [] } });
    catalogMocks.browse.mockResolvedValueOnce({ items: [] });
    const disabledModels = await callHandler("plugins.catalog.browse", { category: "models" });
    expect(disabledModels).toMatchObject({
      ok: true,
      response: {
        items: [{ catalog: { categories: ["models"] }, local: { enabled: false } }],
      },
    });
    expect(managementMocks.inspect).not.toHaveBeenCalled();
  });

  it("preserves a failed browse cursor so the same page remains retryable", async () => {
    catalogMocks.browse.mockRejectedValue(new Error("service unavailable"));
    managementMocks.list.mockResolvedValue({
      plugins: [],
      diagnostics: [],
      mutationAllowed: true,
    });

    const result = await callHandler("plugins.catalog.browse", {
      intent: "all",
      cursor: "page-two",
    });

    expect(result.response).toMatchObject({
      items: [],
      nextCursor: "page-two",
      remoteError:
        "ClawHub is unavailable: service unavailable. Installed plugins remain available.",
    });
  });

  it.each([undefined, "openclaw-control-ui"])(
    "keeps local results private while forwarding catalog search attribution: %s",
    async (searchSource) => {
      const remote = {
        packageName: "@alice/memory-plus",
        displayName: "Memory Plus",
        family: "code-plugin" as const,
        isOfficial: false,
        categories: ["memory"],
        runtimeId: "memory-plus",
      };
      catalogMocks.browse.mockResolvedValue({ items: [remote] });
      managementMocks.list.mockResolvedValue({
        plugins: [
          {
            id: "memory-bundle",
            name: "Memory Bundle",
            packageName: "@openclaw/memory-bundle",
            origin: "bundled",
            installed: false,
            enabled: false,
            state: "not-installed",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      });

      const result = await callHandler("plugins.catalog.browse", {
        query: "memory",
        intent: "all",
        pageSize: 25,
        ...(searchSource ? { searchSource } : {}),
      });

      expect(catalogMocks.browse).toHaveBeenCalledWith({
        query: "memory",
        intent: "all",
        category: undefined,
        cursor: undefined,
        limit: 25,
        ...(searchSource ? { searchSource } : {}),
      });
      expect(result.response).toMatchObject({
        items: [
          { catalog: { name: "Memory Bundle", publishedToClawHub: false } },
          { catalog: { name: "Memory Plus", publishedToClawHub: true } },
        ],
      });
    },
  );

  it("keeps queried Bundled requests limited to unpublished bundled plugins", async () => {
    managementMocks.list.mockResolvedValue({
      plugins: [
        {
          id: "memory-bundle",
          name: "Memory Bundle",
          packageName: "@openclaw/memory-bundle",
          origin: "bundled",
          installed: false,
          enabled: false,
          state: "not-installed",
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    });

    const result = await callHandler("plugins.catalog.browse", {
      query: "memory",
      intent: "bundled",
      pageSize: 25,
    });

    expect(catalogMocks.browse).not.toHaveBeenCalled();
    expect(result.response).toMatchObject({
      items: [{ catalog: { name: "Memory Bundle", publishedToClawHub: false } }],
    });
  });

  it("resolves and inspects an uninstalled official discovery candidate locally", async () => {
    const localOnly = {
      id: "workboard",
      name: "Workboard",
      packageName: "@openclaw/workboard",
      description: "Local work coordination.",
      origin: "official" as const,
      installed: false,
      enabled: false,
      state: "not-installed" as const,
      categories: ["tools"],
      category: "tools",
      install: { source: "official" as const, pluginId: "workboard" },
    };
    managementMocks.list.mockResolvedValue({
      plugins: [
        localOnly,
        {
          id: "other-plugin",
          packageName: "workboard",
          name: "Alias collision",
          installed: false,
          enabled: false,
          state: "not-installed",
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    });
    managementMocks.inspect.mockResolvedValue({
      ok: true,
      plugin: localOnly,
      source: { kind: "official-catalog" },
      overview: {
        capabilities: {
          channels: ["workboard-chat"],
          providers: ["workboard-models"],
          contracts: {},
        },
      },
      declared: {
        channels: ["workboard-chat"],
        providers: ["workboard-models"],
        tools: ["workboard_read"],
        contracts: [],
        hooks: [],
        mcpServers: ["workboard"],
        cliCommands: [],
        cliBackends: [],
        skills: ["Workboard planning"],
        dangerousConfigFlags: [],
      },
      components: emptyInstalledPluginComponents(),
      grants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
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

const readers = vi.hoisted(() => ({ installed: vi.fn(), catalog: vi.fn() }));
// mock-isolation: Skill reads stay inside this RPC boundary fixture.
vi.mock("../../plugins/management-skill-read.js", () => ({
  readManagedPluginSkill: readers.installed,
}));
// mock-isolation: Catalog reads never contact ClawHub in this RPC fixture.
vi.mock("../../infra/clawhub-plugin-skills.js", () => ({
  fetchClawHubPluginSkill: readers.catalog,
}));

async function read(params: Record<string, unknown>) {
  const respond = vi.fn();
  await pluginsHandlers["plugins.skills.read"]!({
    req: { type: "req", id: "skill-read", method: "plugins.skills.read", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
  });
  return respond;
}

describe("plugin skill read Gateway boundary", () => {
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
      const result = await read(
        source === "installed"
          ? { source, pluginId: "example", skillName: "guide" }
          : {
              source,
              catalogId: encodePluginDiscoveryId("@example/plugin"),
              version: "1.0.0",
              skillName: "guide",
            },
      );
      expect(result).toHaveBeenCalledWith(true, bundle, undefined);
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
    { source: "catalog", catalogId: "invalid", version: "1.0.0", skillName: "guide" },
    {
      source: "catalog",
      catalogId: encodePluginDiscoveryId("@example/plugin"),
      skillName: "guide",
    },
    { source: "installed", pluginId: "example", skillName: "guide", path: "/private" },
  ])("rejects invalid source/path requests", async (params) => {
    const result = await read(params);
    expect(result).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

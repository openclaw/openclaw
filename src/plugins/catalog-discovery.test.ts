import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { PluginDiscoveryEntrySchema } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { joinClawHubPluginCatalog, resolvePluginDiscoveryIdentity } from "./catalog-discovery.js";

const remote = {
  packageName: "@alice/memory-plus",
  displayName: "Memory Plus",
  family: "code-plugin" as const,
  isOfficial: false,
  categories: ["memory"],
  runtimeId: "memory-plus",
};

describe("plugin discovery identity and local join", () => {
  it("round-trips a stable URL-safe opaque route identity", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: { plugins: [], diagnostics: [], mutationAllowed: true },
    });
    const id = plugin?.id;
    if (!id) {
      throw new Error("Expected the joined catalog fixture to have an opaque id.");
    }

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).not.toContain(remote.packageName);
    expect(plugin?.catalog).toMatchObject({ packageName: remote.packageName });
    expect(Value.Check(PluginDiscoveryEntrySchema, plugin)).toBe(true);
    expect(resolvePluginDiscoveryIdentity(id)).toEqual({
      origin: "clawhub",
      identity: remote.packageName,
    });
    expect(resolvePluginDiscoveryIdentity("@alice/memory-plus")).toBeUndefined();
  });

  it("joins a recorded ClawHub package identity to authoritative Gateway state", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: {
        plugins: [
          {
            id: "memory-plus",
            name: "Memory Plus",
            clawhubPackage: "@alice/memory-plus",
            installed: true,
            enabled: false,
            state: "needs-setup",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
    });

    expect(plugin?.local).toEqual({
      present: true,
      installed: true,
      enabled: false,
      state: "needs-setup",
      pluginId: "memory-plus",
      action: "manage",
    });
  });

  it("does not treat an unrelated runtime alias as installed", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: {
        plugins: [
          {
            id: "memory-plus",
            name: "Different package",
            installed: true,
            enabled: true,
            state: "enabled",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
    });

    expect(plugin?.local).toMatchObject({ installed: false, state: "not-installed" });
  });

  it("does not claim install eligibility when Gateway mutation is disabled", () => {
    const [plugin] = joinClawHubPluginCatalog({
      remote: [remote],
      local: { plugins: [], diagnostics: [], mutationAllowed: false },
    });

    expect(plugin?.local).toEqual({
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: "unavailable",
    });
  });

  it("deduplicates canonical and aliased local entries while preserving local state", () => {
    const items = joinClawHubPluginCatalog({
      remote: [remote],
      local: {
        plugins: [
          {
            id: "memory-plus",
            packageName: "@alice/memory-plus",
            clawhubPackage: "@alice/memory-plus",
            name: "Local presentation",
            installed: true,
            enabled: true,
            state: "enabled",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
      published: [],
      includeBundledOnly: true,
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.catalog.name).toBe("Memory Plus");
    expect(items[0]?.local.state).toBe("enabled");
  });

  it("places unpublished bundled entries before ClawHub results only when requested", () => {
    const bundledOnly = {
      id: "calendar-local",
      name: "Calendar Local",
      description: "Coordinate a local calendar.",
      packageName: "@openclaw/calendar-local",
      origin: "bundled",
      installed: false,
      enabled: false,
      state: "not-installed" as const,
      categories: ["tools", "web"],
      category: "tools",
      install: { source: "official" as const, pluginId: "calendar-local" },
    };
    const local = { plugins: [bundledOnly], diagnostics: [], mutationAllowed: true };

    const all = joinClawHubPluginCatalog({
      remote: [remote],
      local,
      intent: "all",
    });
    const tools = joinClawHubPluginCatalog({
      remote: [],
      local,
      includeBundledOnly: true,
      published: [remote],
      intent: "bundled",
      category: "web",
    });

    expect(all.map((item) => item.catalog.name)).toEqual(["Memory Plus"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      catalog: {
        packageName: bundledOnly.packageName,
        categories: ["tools", "web"],
        official: false,
        publishedToClawHub: false,
      },
      local: {
        present: true,
        action: "install",
        install: { source: "official", pluginId: "calendar-local" },
      },
    });
    expect(resolvePluginDiscoveryIdentity(tools[0]?.id ?? "")).toEqual({
      origin: "local",
      identity: "calendar-local",
    });
  });

  it("uses the complete publication set so a later ClawHub page cannot become a bundled result", () => {
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
          name: "Expedia Travel",
          origin: "official",
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
      published: [expedia],
      local,
      includeBundledOnly: true,
      intent: "bundled",
    });

    expect(items.map((item) => item.catalog.name)).toEqual(["Private Bundle"]);
  });

  it("does not repeat local-only entries on remote cursor pages", () => {
    const items = joinClawHubPluginCatalog({
      remote: [remote],
      published: [],
      local: {
        plugins: [
          {
            id: "private-bundle",
            name: "Private Bundle",
            origin: "bundled",
            installed: false,
            enabled: false,
            state: "not-installed",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
      includeBundledOnly: true,
      intent: "all",
      cursor: "page-two",
    });

    expect(items.map((item) => item.catalog.name)).toEqual(["Memory Plus"]);
  });

  it("keeps unmatched installed entries in All search and deduplicates remote matches", () => {
    const items = joinClawHubPluginCatalog({
      remote: [remote],
      published: [],
      local: {
        plugins: [
          {
            id: "workspace-memory",
            name: "Memory Workspace",
            origin: "workspace",
            installed: true,
            enabled: true,
            state: "enabled",
          },
          {
            id: "global-memory",
            name: "Memory Sidecar",
            origin: "global",
            installed: true,
            enabled: false,
            state: "disabled",
          },
          {
            id: "memory-plus",
            name: "Memory Remote Local",
            clawhubPackage: "@alice/memory-plus",
            origin: "global",
            installed: true,
            enabled: false,
            state: "needs-setup",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
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
      state: "needs-setup",
      action: "manage",
    });
  });

  it("keeps installed packages when ClawHub publication exists but the search page omits them", () => {
    const items = joinClawHubPluginCatalog({
      remote: [],
      published: [remote],
      local: {
        plugins: [
          {
            id: "memory-plus",
            name: "Memory Plus",
            clawhubPackage: remote.packageName,
            origin: "global",
            installed: true,
            enabled: false,
            state: "disabled",
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      },
      includeBundledOnly: true,
      intent: "all",
      query: "memory",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      catalog: { packageName: remote.packageName, name: "Memory Plus" },
      local: { pluginId: "memory-plus", installed: true, state: "disabled" },
    });
    expect(resolvePluginDiscoveryIdentity(items[0]?.id ?? "")).toEqual({
      origin: "clawhub",
      identity: remote.packageName,
    });
  });

  it("filters bundled entries for unified search and keeps them ahead of ClawHub results", () => {
    const local = {
      plugins: [
        {
          id: "calendar-local",
          name: "Memory Calendar",
          description: "Coordinate a local calendar.",
          installed: false,
          enabled: false,
          state: "not-installed" as const,
          category: "tool",
          origin: "bundled",
          install: { source: "official" as const, pluginId: "calendar-local" },
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    };
    const common = {
      remote: [remote],
      published: [remote],
      local,
      includeBundledOnly: true,
    } as const;

    expect(
      joinClawHubPluginCatalog({ ...common, query: "memory" }).map((item) => item.catalog.name),
    ).toEqual(["Memory Calendar", "Memory Plus"]);
    expect(joinClawHubPluginCatalog({ ...common, remote: [], query: "unrelated" })).toHaveLength(0);
  });
});

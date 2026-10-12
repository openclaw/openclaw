// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { setCurrentThemeBranding } from "../../app/theme-branding.ts";
import { i18n } from "../../i18n/index.ts";
import { findSettingsSearchBlocks } from "./settings-search.ts";

afterEach(async () => {
  await i18n.setLocale("en");
  setCurrentThemeBranding(resolveThemeBranding(undefined));
});

describe("findSettingsSearchBlocks", () => {
  it("does not advertise hidden Lobsterdex choices while retaining the rest of tab icon settings", () => {
    const search = (query: string) =>
      findSettingsSearchBlocks({ query, schema: null, value: {}, uiHints: {} });
    setCurrentThemeBranding(resolveThemeBranding({ lobsterdex: false }));
    expect(search("Lobsterdex")).toEqual([]);
    expect(search("favicon")).toContainEqual(expect.objectContaining({ routeId: "appearance" }));
    setCurrentThemeBranding(resolveThemeBranding({ lobsterdex: true }));
    expect(search("Lobsterdex")).toContainEqual(expect.objectContaining({ routeId: "appearance" }));
  });
  it("loads Settings English only when cold search opens, before the config page", async () => {
    // The ordinary imports above exercise warm search. This module graph starts
    // at the runtime barrel, without importing a page or priming its catalogs.
    const testApiKey = Symbol.for("openclaw.i18nManagerTestApi");
    const previousTestApi = Object.getOwnPropertyDescriptor(globalThis, testApiKey);
    vi.resetModules();
    const runtime = await import("../../i18n/index.ts");
    const { en } = await import("../../i18n/locales/en.ts");
    await runtime.i18n.setLocale("en");
    const configView = en.configView;
    const updates = en.updates;
    const campaign = (updates as Record<string, unknown>).campaign;
    const sharedKeys = [
      "configView.autoSaveSaving",
      "configView.rawDraftBlocksApply",
      "updates.confirm.message",
      "updates.outcomeUnknown",
    ];
    const sharedCopy = sharedKeys.map((key) => runtime.t(key));
    const lazyKeys = [
      "configPage.themeImported",
      "configView.chatPrefs.title",
      "configView.notifications.title",
      "updates.page.intro",
      "updates.channel.stable",
      "updates.installKind.git",
      "modelProviders.title",
      "modelProviders.defaults.utilityHelpPurpose",
    ];
    try {
      for (const key of lazyKeys) {
        expect(runtime.t(key), key).toBe(key);
      }
      const { findSettingsSearchBlocks: search } = await import("./settings-search.ts");
      const find = (query: string) => search({ query, schema: null, value: null, uiHints: {} });

      expect(find("check for updates")).toEqual([
        expect.objectContaining({ routeId: "updates", label: "Updates" }),
      ]);
      expect(find("collapse task progress")).toEqual([
        expect.objectContaining({ routeId: "appearance", label: "Chat" }),
      ]);
      expect(en.configView).toBe(configView);
      expect(en.updates).toBe(updates);
      expect((en.updates as Record<string, unknown>).campaign).toBe(campaign);
      expect(sharedKeys.map((key) => runtime.t(key))).toEqual(sharedCopy);
      for (const key of lazyKeys) {
        expect(runtime.t(key), key).not.toBe(key);
      }
      expect(runtime.t("configPage.themeImported", { name: "Example" })).toBe("Imported Example.");
      expect(runtime.t("updates.page.intro")).toBe(
        "Manage the connected Gateway's release channel and update policy.",
      );

      runtime.i18n.registerTranslation("fr", {
        configView: { chatPrefs: { title: "Discussion" } },
      });
      await runtime.i18n.setLocale("fr");
      expect(find("Discussion")).toEqual([
        expect.objectContaining({ routeId: "appearance", label: "Discussion" }),
      ]);
      expect(find("check for updates")).toEqual([
        expect.objectContaining({ routeId: "updates", label: "Updates" }),
      ]);
      expect(runtime.t("modelProviders.title")).toBe("Configured providers");
      expect(runtime.t("modelProviders.modelsAvailable", { available: "2", count: "3" })).toBe(
        "2 of 3 models available",
      );
      expect(runtime.t("settings.missing.key")).toBe("settings.missing.key");
      await runtime.i18n.setLocale("en");
      expect(find("collapse task progress")).toEqual([
        expect.objectContaining({ routeId: "appearance", label: "Chat" }),
      ]);
    } finally {
      await runtime.i18n.setLocale("en");
      vi.resetModules();
      if (previousTestApi) {
        Object.defineProperty(globalThis, testApiKey, previousTestApi);
      } else {
        Reflect.deleteProperty(globalThis, testApiKey);
      }
    }
  });

  it("uses word prefixes instead of arbitrary substrings for short queries", () => {
    const matches = findSettingsSearchBlocks({
      query: "cp",
      schema: {
        type: "object",
        properties: {
          mcp: { type: "object", title: "MCP" },
          acp: { type: "object", title: "ACP" },
        },
      },
      value: {},
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "connection",
        label: "Gateway Host",
        hash: "#settings-connection-host",
      }),
    ]);
  });

  it.each(["securityAcknowledgedAt"])("does not offer machine-owned %s in search", (key) => {
    expect(
      findSettingsSearchBlocks({
        query: "internal bookkeeping",
        schema: {
          type: "object",
          properties: {
            wizard: {
              type: "object",
              properties: {
                [key]: { type: "string", title: "Internal Bookkeeping" },
                accessMode: { type: "string" },
              },
            },
          },
        },
        value: { wizard: { [key]: "internal bookkeeping" } },
        uiHints: {},
      }),
    ).toEqual([]);
  });

  it("opens every Memory schema match on the merged Settings tab", () => {
    const memorySchema = {
      type: "object",
      properties: {
        memory: {
          type: "object",
          properties: {
            search: {
              type: "object",
              properties: { embeddingModel: { type: "string", title: "Embedding model" } },
            },
          },
        },
      },
    };
    const uiHints = {
      "memory.search": { advanced: false },
      "memory.search.embeddingModel": { advanced: false },
    };

    const searchOnly = findSettingsSearchBlocks({
      query: "embedding model",
      schema: memorySchema,
      value: {},
      uiHints,
    });
    expect(searchOnly).toEqual([
      expect.objectContaining({
        routeId: "memory",
        pathname: "/settings/memory/settings",
      }),
    ]);

    const sectionWide = findSettingsSearchBlocks({
      query: "memory",
      schema: memorySchema,
      value: {},
      uiHints,
    }).filter((block) => block.routeId === "memory");
    expect(sectionWide).toEqual([
      expect.objectContaining({
        routeId: "memory",
        pathname: "/settings/memory/settings",
        hash: "#config-section-memory",
      }),
    ]);
  });

  it("refreshes prepared schema tiers while searching current draft keys and access", () => {
    const schema = {
      type: "object",
      properties: {
        mcp: {
          type: "object",
          properties: {
            servers: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: { command: { type: "string" } },
              },
            },
          },
        },
      },
    };
    const servers: Record<string, { command: string }> = {};
    const params = {
      query: "zephyr",
      schema,
      value: { mcp: { servers } },
      uiHints: { "mcp.servers.*.command": { advanced: false } },
    };
    expect(findSettingsSearchBlocks(params)).toEqual([]);
    servers.zephyr = { command: "node" };
    const common = {
      routeId: "mcp",
      label: "MCP",
      search: "?section=mcp",
      hash: "#config-section-mcp",
    };
    expect(findSettingsSearchBlocks(params)).toEqual([common]);
    expect(findSettingsSearchBlocks({ ...params, canAdmin: false })).toEqual([]);
    expect(findSettingsSearchBlocks(params)).toEqual([common]);
    expect(findSettingsSearchBlocks({ ...params, uiHints: {} })).toEqual([
      { ...common, search: "?section=mcp&advanced=1" },
    ]);
    expect(findSettingsSearchBlocks(params)).toEqual([common]);
    expect(
      findSettingsSearchBlocks({
        ...params,
        schema: {
          type: "object",
          properties: { mcp: { type: "object", properties: { endpoint: { type: "string" } } } },
        },
      }),
    ).toEqual([]);
    expect(findSettingsSearchBlocks(params)).toEqual([common]);
    delete servers.zephyr;
    expect(findSettingsSearchBlocks(params)).toEqual([]);
  });

  it("omits admin-only static and schema results for non-admin viewers", () => {
    expect(
      findSettingsSearchBlocks({
        query: "security",
        schema: {
          type: "object",
          properties: { security: { type: "object", title: "Security" } },
        },
        value: {},
        uiHints: {},
        canAdmin: false,
      }),
    ).toEqual([]);
  });

  it("routes global plugin policy to Plugin Settings without indexing plugin entries", () => {
    const schema = {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          title: "Plugin policy",
          properties: {
            enabled: { type: "boolean", title: "Enable plugins" },
            entries: { type: "object", title: "Plugin entries" },
          },
        },
      },
    };
    const common = {
      schema,
      value: { plugins: { enabled: true, entries: { workboard: {} } } },
      uiHints: {},
    };

    expect(findSettingsSearchBlocks({ query: "Enable plugins", ...common })).toEqual([
      expect.objectContaining({
        routeId: "plugin-settings",
        search: "?tab=advanced",
        hash: "#plugin-settings-advanced",
      }),
    ]);
    expect(findSettingsSearchBlocks({ query: "Plugin entries", ...common })).toEqual([]);
  });

  it("searches and displays static settings blocks in the active locale", async () => {
    await i18n.setLocale("es");

    const matches = findSettingsSearchBlocks({
      query: "modelo",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "model-providers",
        hash: "#settings-model-behavior",
      }),
      expect.objectContaining({
        routeId: "appearance",
        hash: "#settings-appearance-sidebar",
      }),
    ]);
  });

  it("does not create block results for an empty query", () => {
    expect(
      findSettingsSearchBlocks({
        query: "  ",
        schema: null,
        value: null,
        uiHints: {},
      }),
    ).toEqual([]);
  });

  it("only exposes the identity block when the connection has an identity", () => {
    const search = (identityAvailable: boolean) =>
      findSettingsSearchBlocks({
        query: "avatar",
        schema: null,
        value: null,
        uiHints: {},
        identityAvailable,
      }).filter((entry) => entry.hash === "#settings-profile-identity");

    expect(search(false)).toEqual([]);
    expect(search(true)).toEqual([
      expect.objectContaining({
        routeId: "profile",
        hash: "#settings-profile-identity",
      }),
    ]);
  });
});

it("only offers personal instructions search on a multi-user Gateway", () => {
  const search = (multipleProfiles: boolean) =>
    findSettingsSearchBlocks({
      query: "personal instructions",
      schema: null,
      value: null,
      uiHints: {},
      identityAvailable: true,
      multipleProfiles,
    });
  expect(
    search(false).some((block) => block.hash === "#settings-profile-personal-instructions"),
  ).toBe(false);
  expect(
    search(true).some((block) => block.hash === "#settings-profile-personal-instructions"),
  ).toBe(true);
});

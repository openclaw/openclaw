// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { SettingsSearchBlock } from "../../app-navigation.ts";
import { setCurrentThemeBranding } from "../../app/theme-branding.ts";
import { i18n } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { findSettingsSearchBlocks } from "./settings-search.ts";

function object(
  properties: Record<string, JsonSchema>,
  options: Partial<JsonSchema> = {},
): JsonSchema {
  return { type: "object", properties, ...options };
}
const field = (title?: string): JsonSchema => ({ type: "string", ...(title ? { title } : {}) });
const section = (name: string, properties: Record<string, JsonSchema>) =>
  object({ [name]: object(properties) });

type SearchOptions = Partial<Parameters<typeof findSettingsSearchBlocks>[0]>;
function search(query: string, options: SearchOptions = {}) {
  return findSettingsSearchBlocks({ query, schema: null, value: null, uiHints: {}, ...options });
}
function expectBlocks(actual: SettingsSearchBlock[], ...expected: Partial<SettingsSearchBlock>[]) {
  expect(actual).toEqual(expected.map((block) => expect.objectContaining(block)));
}

afterEach(async () => {
  await i18n.setLocale("en");
  setCurrentThemeBranding(resolveThemeBranding(undefined));
});

it("does not advertise hidden Lobsterdex choices while retaining the rest of tab icon settings", () => {
  setCurrentThemeBranding(resolveThemeBranding({ lobsterdex: false }));
  expect(search("Lobsterdex")).toEqual([]);
  expect(search("favicon")).toContainEqual(expect.objectContaining({ routeId: "appearance" }));
  setCurrentThemeBranding(resolveThemeBranding({ lobsterdex: true }));
  expect(search("Lobsterdex")).toContainEqual(expect.objectContaining({ routeId: "appearance" }));
});
it("keeps target metadata cold and loads Settings English when search opens", async () => {
  const testApiKey = Symbol.for("openclaw.i18nManagerTestApi");
  const previousTestApi = Object.getOwnPropertyDescriptor(globalThis, testApiKey);
  vi.resetModules();
  const runtime = await import("../../i18n/index.ts");
  const { en } = await import("../../i18n/locales/en.ts");
  await runtime.i18n.setLocale("en");
  const configView = en.configView;
  const updates = en.updates;
  const campaign = (updates as Record<string, unknown>).campaign;
  const sharedKeys = ["configView.adminRequired", "updates.confirm.message"];
  const sharedCopy = sharedKeys.map((key) => runtime.t(key));
  const lazyKeys = [
    "configView.autoSaveSaving",
    "configPage.themeImported",
    "configView.chatPrefs.title",
    "updates.page.intro",
    "modelProviders.title",
  ];
  try {
    await import("./settings-targets.ts");
    for (const key of lazyKeys) {
      expect(runtime.t(key), key).toBe(key);
    }
    const { findSettingsSearchBlocks: coldSearch } = await import("./settings-search.ts");
    const find = (query: string) => coldSearch({ query, schema: null, value: null, uiHints: {} });

    expectBlocks(find("check for updates"), { routeId: "updates", label: "Updates" });
    expectBlocks(find("collapse task progress"), { routeId: "appearance", label: "Chat" });
    expect(en.configView).toBe(configView);
    expect(en.updates).toBe(updates);
    expect((en.updates as Record<string, unknown>).campaign).toBe(campaign);
    expect(sharedKeys.map((key) => runtime.t(key))).toEqual(sharedCopy);
    for (const key of lazyKeys) {
      expect(runtime.t(key), key).not.toBe(key);
    }

    runtime.i18n.registerTranslation("fr", {
      configView: { chatPrefs: { title: "Discussion" } },
    });
    await runtime.i18n.setLocale("fr");
    expectBlocks(find("Discussion"), { routeId: "appearance", label: "Discussion" });
    expectBlocks(find("check for updates"), { routeId: "updates", label: "Updates" });
    expect(runtime.t("modelProviders.modelsAvailable", { available: "2", count: "3" })).toBe(
      "2 of 3 models available",
    );
    expect(runtime.t("settings.missing.key")).toBe("settings.missing.key");
    await runtime.i18n.setLocale("en");
    expectBlocks(find("collapse task progress"), { routeId: "appearance", label: "Chat" });
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

it.each(["securityAcknowledgedAt"])("does not offer machine-owned %s in search", (key) => {
  expect(
    search("internal bookkeeping", {
      schema: section("wizard", { [key]: field("Internal Bookkeeping"), accessMode: field() }),
      value: { wizard: { [key]: "internal bookkeeping" } },
    }),
  ).toEqual([]);
});

it("opens every Memory schema match on the merged Settings tab", () => {
  const memorySchema = section("memory", {
    search: object({ embeddingModel: field("Embedding model") }),
  });
  const uiHints = {
    "memory.search": { advanced: false },
    "memory.search.embeddingModel": { advanced: false },
  };

  const find = (query: string) => search(query, { schema: memorySchema, value: {}, uiHints });
  const destination = { routeId: "memory", pathname: "/settings/memory/settings" } as const;
  expectBlocks(find("embedding model"), destination);
  expectBlocks(
    find("memory").filter((block) => block.routeId === "memory"),
    { ...destination, hash: "#config-section-memory" },
  );
});

it("hides the curated locale search leaf without mutating the source schema or sibling hits", () => {
  const schema = section("ui", {
    seamColor: field("Seam color"),
    prefs: object({
      locale: field("Interface language"),
      chatShowToolCalls: { type: "boolean", title: "Chat show tool calls" },
    }),
  });
  const original = JSON.stringify(schema);
  const uiHints = {
    "ui.seamColor": { advanced: false },
    "ui.prefs.locale": { advanced: false },
    "ui.prefs.chatShowToolCalls": { advanced: false },
  };
  const params = { schema, value: { ui: { prefs: { locale: "en" } } }, uiHints };

  expect(
    search("interface language", params).some((block) => block.hash === "#config-section-ui"),
  ).toBe(false);
  for (const query of ["chat show tool calls", "seam color"]) {
    expect(search(query, params)).toContainEqual(
      expect.objectContaining({ hash: "#config-section-ui" }),
    );
  }
  expect(JSON.stringify(schema)).toBe(original);
});

it("refreshes prepared schema tiers while searching current draft keys and access", () => {
  const schema = section("mcp", {
    servers: object({}, { additionalProperties: object({ command: field() }) }),
  });
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
  const check = (overrides: SearchOptions = {}, expected = [common]) =>
    expect(findSettingsSearchBlocks({ ...params, ...overrides })).toEqual(expected);
  check();
  check({ canAdmin: false }, []);
  check();
  check({ uiHints: {} }, [{ ...common, search: "?section=mcp&advanced=1" }]);
  check();
  check({ schema: section("mcp", { endpoint: field() }) }, []);
  check();
  delete servers.zephyr;
  check({}, []);
});

it("omits admin-only static and schema results for non-admin viewers", () => {
  expect(
    search("security", {
      schema: object({ security: { type: "object", title: "Security" } }),
      value: {},
      canAdmin: false,
    }),
  ).toEqual([]);
});

it("routes global plugin policy to Plugin Settings without indexing plugin entries", () => {
  const schema = object({
    plugins: object(
      {
        enabled: { type: "boolean", title: "Enable plugins" },
        entries: { type: "object", title: "Plugin entries" },
      },
      { title: "Plugin policy" },
    ),
  });
  const common = {
    schema,
    value: { plugins: { enabled: true, entries: { workboard: {} } } },
    uiHints: {},
  };

  expectBlocks(search("Enable plugins", common), {
    routeId: "plugin-settings",
    search: "?tab=advanced",
    hash: "#plugin-settings-advanced",
  });
  expect(findSettingsSearchBlocks({ query: "Plugin entries", ...common })).toEqual([]);
});

it("searches and displays static settings blocks in the active locale", async () => {
  await i18n.setLocale("es");

  expectBlocks(
    search("modelo"),
    { routeId: "model-providers", hash: "#settings-model-behavior" },
    { routeId: "appearance", hash: "#settings-appearance-sidebar" },
  );
});

it("does not create block results for an empty query", () => {
  expect(search("  ")).toEqual([]);
});

it("only exposes the identity block when the connection has an identity", () => {
  const identity = (identityAvailable: boolean) =>
    search("avatar", { identityAvailable }).filter(
      (entry) => entry.hash === "#settings-profile-identity",
    );

  expect(identity(false)).toEqual([]);
  expectBlocks(identity(true), { routeId: "profile", hash: "#settings-profile-identity" });
});
it("only offers personal instructions search on a multi-user Gateway", () => {
  const personal = (multipleProfiles: boolean) =>
    search("personal instructions", { identityAvailable: true, multipleProfiles });
  expect(
    personal(false).some((block) => block.hash === "#settings-profile-personal-instructions"),
  ).toBe(false);
  expect(
    personal(true).some((block) => block.hash === "#settings-profile-personal-instructions"),
  ).toBe(true);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import * as channelCatalog from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { initializeNativeSessionCatalogPreferences } from "../../../plugins/native-session-catalog-config.js";
import * as providerInstallCatalog from "../../../plugins/provider-install-catalog.js";
import { collectUpdateDeferredPluginIds } from "./missing-configured-plugin-install.candidates.js";
import { collectConfiguredPluginIds } from "./missing-configured-plugin-install.ids.js";

describe("Doctor plugin installation intent", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "empty environment", env: {}, expected: [] },
    {
      name: "environment-selected provider",
      env: { GROQ_API_KEY: "test-provider-key" },
      expected: ["groq"],
    },
  ])("does not read unrelated provider catalogs with $name", ({ env, expected }) => {
    vi.spyOn(providerInstallCatalog, "resolveProviderInstallCatalogEntries").mockImplementation(
      () => {
        throw new Error("Unrelated provider catalog is unavailable");
      },
    );
    expect(collectConfiguredPluginIds({}, env)).toEqual(new Set(expected));
  });

  it("does not read install catalogs without selected plugins or channels", () => {
    vi.spyOn(channelCatalog, "listRawChannelPluginCatalogEntries").mockImplementation(() => {
      throw new Error("Unrelated channel catalog is unavailable");
    });
    vi.spyOn(providerInstallCatalog, "resolveProviderInstallCatalogEntries").mockImplementation(
      () => {
        throw new Error("Unrelated provider catalog is unavailable");
      },
    );
    expect(
      collectUpdateDeferredPluginIds({
        cfg: {},
        env: {},
        configuredPluginIds: new Set(),
        configuredChannelIds: new Set(),
      }),
    ).toEqual(new Set());
  });

  it("does not install plugins merely to persist fresh native conversation opt-outs", () => {
    const cfg = initializeNativeSessionCatalogPreferences({});
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set());
  });

  it.each([
    { name: "explicit enablement", entry: { enabled: true } },
    { name: "additional plugin settings", entry: { config: { extra: true } } },
    {
      name: "conversation discovery opt-in",
      entry: { config: { sessionCatalog: { enabled: true } } },
    },
  ])("preserves $name as installation intent", ({ entry }) => {
    const cfg = initializeNativeSessionCatalogPreferences({
      plugins: { entries: { codex: entry } },
    });
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set(["codex"]));
  });

  it("retains a selected runtime even when its native conversations are disabled", () => {
    const cfg: OpenClawConfig = initializeNativeSessionCatalogPreferences({
      agents: { defaults: { models: { "example/starter": { agentRuntime: { id: "codex" } } } } },
    });
    expect(collectConfiguredPluginIds(cfg, {}).has("codex")).toBe(true);
  });

  it("does not treat an undeclared plugin setting as a host-generated opt-out", () => {
    const cfg = initializeNativeSessionCatalogPreferences({
      plugins: { entries: { unrelated: { config: { sessionCatalog: { enabled: false } } } } },
    });
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set(["unrelated"]));
  });
});

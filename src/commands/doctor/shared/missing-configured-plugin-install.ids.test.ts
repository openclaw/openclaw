import { afterEach, describe, expect, it, vi } from "vitest";
import * as channelCatalog from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { initializeNativeSessionCatalogPreferences } from "../../../plugins/native-session-catalog-config.js";
import * as providerInstallCatalog from "../../../plugins/provider-install-catalog.js";
import { collectUpdateDeferredPluginIds } from "./missing-configured-plugin-install.candidates.js";
import { collectConfiguredPluginIds } from "./missing-configured-plugin-install.ids.js";

describe("Doctor plugin installation intent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not read unrelated provider catalogs for an environment-selected provider", () => {
    vi.spyOn(providerInstallCatalog, "resolveProviderInstallCatalogEntries").mockImplementation(
      () => {
        throw new Error("Unrelated provider catalog is unavailable");
      },
    );
    expect(collectConfiguredPluginIds({}, { GROQ_API_KEY: "test-provider-key" })).toEqual(
      new Set(["groq"]),
    );
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

  it("preserves explicit enablement as installation intent", () => {
    const cfg = initializeNativeSessionCatalogPreferences({
      plugins: { entries: { codex: { enabled: true } } },
    });
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set(["codex"]));
  });

  it("retains a selected runtime even when its native conversations are disabled", () => {
    const cfg: OpenClawConfig = initializeNativeSessionCatalogPreferences({
      agents: { defaults: { models: { "example/starter": { agentRuntime: { id: "codex" } } } } },
    });
    expect(collectConfiguredPluginIds(cfg, {}).has("codex")).toBe(true);
  });
});

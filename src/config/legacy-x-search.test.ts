import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { listLegacyXSearchConfigPaths, migrateLegacyXSearchConfig } from "./legacy-x-search.js";

describe("legacy x_search config migration", () => {
  it("moves legacy x_search auth and settings into the xai plugin config", () => {
    const res = migrateLegacyXSearchConfig({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "grok-4-1-fast",
          },
        } as Record<string, unknown>,
      },
    } as OpenClawConfig);

    expect(
      (res.config.tools?.web as Record<string, unknown> | undefined)?.x_search,
    ).toBeUndefined();
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-legacy-key",
        },
        xSearch: {
          enabled: true,
          model: "grok-4-1-fast",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
      "Moved tools.web.x_search → plugins.entries.xai.config.xSearch.",
    ]);
  });

  it("keeps explicit plugin-owned values when migrating legacy x_search config", () => {
    const res = migrateLegacyXSearchConfig({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "legacy-model",
            cacheTtlMinutes: 5,
          },
        } as Record<string, unknown>,
      },
      plugins: {
        entries: {
          xai: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "plugin-key",
              },
              xSearch: {
                model: "plugin-model",
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(res.config.plugins?.entries?.xai?.config).toEqual({
      webSearch: {
        apiKey: "plugin-key",
      },
      xSearch: {
        enabled: true,
        model: "plugin-model",
        cacheTtlMinutes: 5,
      },
    });
  });

  it("lists legacy x_search paths", () => {
    expect(
      listLegacyXSearchConfigPaths({
        tools: {
          web: {
            x_search: {
              apiKey: "xai-legacy-key",
              enabled: false,
            },
          } as Record<string, unknown>,
        },
      } as OpenClawConfig),
    ).toEqual(["tools.web.x_search.apiKey", "tools.web.x_search.enabled"]);
  });
});

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebSearchConfig,
} from "./legacy-web-search-migrate.js";

describe("legacy web search config", () => {
  it("migrates legacy provider config through bundled web search ownership metadata", () => {
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            provider: "grok",
            apiKey: "brave-key",
            grok: {
              apiKey: "xai-key",
              model: "grok-4-search",
            },
            kimi: {
              apiKey: "kimi-key",
              model: "kimi-k2.5",
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      provider: "grok",
    });
    expect(res.config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-key",
          model: "grok-4-search",
        },
      },
    });
    expect(res.config.plugins?.entries?.moonshot).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "kimi-key",
          model: "kimi-k2.5",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
      "Moved tools.web.search.kimi → plugins.entries.moonshot.config.webSearch.",
    ]);
  });

  it("preserves unrelated record-valued tools.web.search keys (#83287)", () => {
    // Previous shape dropped any record-valued key not in a short modern
    // allowlist, silently erasing operator-added custom provider configs that
    // happened to live under tools.web.search.
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            provider: "grok",
            apiKey: "brave-key",
            grok: {
              apiKey: "xai-key",
              model: "grok-4-search",
            },
            "custom-provider": {
              endpoint: "https://example.com/search",
              apiKey: "custom-key",
            },
          },
        },
      } as unknown as OpenClawConfig["tools"],
    } as OpenClawConfig);

    expect(res.config.tools?.web?.search).toEqual({
      provider: "grok",
      "custom-provider": {
        endpoint: "https://example.com/search",
        apiKey: "custom-key",
      },
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-key",
          model: "grok-4-search",
        },
      },
    });
    expect(res.config.plugins?.entries?.["custom-provider"]).toBeUndefined();
  });

  it("preserves openaiCodex scoped web search config (#83287 regression)", () => {
    // Confirms the previously-allowlisted modern key still survives now that
    // the allowlist was widened to "preserve everything that wasn't a legacy
    // provider".
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            apiKey: "brave-key",
            openaiCodex: {
              provider: "openai",
              limit: 5,
            },
          },
        },
      } as unknown as OpenClawConfig["tools"],
    } as OpenClawConfig);

    expect(res.config.tools?.web?.search?.openaiCodex).toEqual({
      provider: "openai",
      limit: 5,
    });
  });

  it("lists legacy paths for metadata-owned provider config", () => {
    expect(
      listLegacyWebSearchConfigPaths({
        tools: {
          web: {
            search: {
              apiKey: "brave-key",
              grok: {
                apiKey: "xai-key",
                model: "grok-4-search",
              },
              kimi: {
                model: "kimi-k2.5",
              },
            },
          },
        },
      }),
    ).toEqual([
      "tools.web.search.apiKey",
      "tools.web.search.grok.apiKey",
      "tools.web.search.grok.model",
      "tools.web.search.kimi.model",
    ]);
  });
});

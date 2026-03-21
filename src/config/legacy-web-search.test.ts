import { describe, expect, it } from "vitest";
import {
  listLegacyWebSearchConfigPaths,
  normalizeLegacyWebSearchConfig,
} from "./legacy-web-search.js";

describe("legacy web search config", () => {
  it("migrates brightdata scoped config into plugin webSearch config", () => {
    const normalized = normalizeLegacyWebSearchConfig({
      tools: {
        web: {
          search: {
            provider: "brightdata",
            brightdata: {
              apiKey: "brightdata-key", // pragma: allowlist secret
              baseUrl: "https://example-proxy.invalid",
            },
          },
        },
      },
    });

    expect(normalized).toEqual({
      tools: {
        web: {
          search: {
            provider: "brightdata",
          },
        },
      },
      plugins: {
        entries: {
          brightdata: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "brightdata-key",
                baseUrl: "https://example-proxy.invalid",
              },
            },
          },
        },
      },
    });
  });

  it("lists legacy brightdata config paths for migration diagnostics", () => {
    expect(
      listLegacyWebSearchConfigPaths({
        tools: {
          web: {
            search: {
              brightdata: {
                apiKey: "brightdata-key", // pragma: allowlist secret
                baseUrl: "https://example-proxy.invalid",
              },
            },
          },
        },
      }),
    ).toEqual(["tools.web.search.brightdata.apiKey", "tools.web.search.brightdata.baseUrl"]);
  });
});

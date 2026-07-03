// Web search tests cover model-facing schema limits, provider-specific time
// filters, unsupported filter errors, and scoped provider config merging.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  MAX_SEARCH_COUNT,
  buildUnsupportedSearchFilterResponse,
  isoToPerplexityDate,
  normalizeToIsoDate,
  normalizeFreshness,
  parseWebSearchTimeFilters,
} from "./web-search-provider-common.js";
import { mergeScopedSearchConfig } from "./web-search-provider-config.js";
import { createWebSearchTool } from "./web-search.js";

describe("web_search tool schema", () => {
  it("marks query as required for model tool-call schemas", () => {
    const tool = createWebSearchTool();
    const parameters = tool?.parameters as { required?: unknown } | undefined;

    expect(parameters?.required).toEqual(["query"]);
  });

  it("advertises the shared runtime count limit", () => {
    const tool = createWebSearchTool();
    const parameters = tool?.parameters as
      | { properties?: { count?: { maximum?: unknown } } }
      | undefined;

    expect(parameters?.properties?.count?.maximum).toBe(MAX_SEARCH_COUNT);
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values and maps for Perplexity", () => {
    expect(normalizeFreshness("pd", "brave")).toBe("pd");
    expect(normalizeFreshness("PW", "brave")).toBe("pw");
    expect(normalizeFreshness("pd", "perplexity")).toBe("day");
    expect(normalizeFreshness("pw", "perplexity")).toBe("week");
  });

  it("accepts Perplexity values and maps for Brave", () => {
    expect(normalizeFreshness("day", "perplexity")).toBe("day");
    expect(normalizeFreshness("week", "perplexity")).toBe("week");
    expect(normalizeFreshness("day", "brave")).toBe("pd");
    expect(normalizeFreshness("week", "brave")).toBe("pw");
  });

  it("accepts valid date ranges for Brave", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31", "brave")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid values", () => {
    expect(normalizeFreshness("yesterday", "brave")).toBeUndefined();
    expect(normalizeFreshness("yesterday", "perplexity")).toBeUndefined();
    expect(normalizeFreshness("2024-01-01to2024-01-31", "perplexity")).toBeUndefined();
  });

  it("rejects invalid date ranges for Brave", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01", "brave")).toBeUndefined();
  });
});

describe("web_search date normalization", () => {
  it("accepts ISO format", () => {
    expect(normalizeToIsoDate("2024-01-15")).toBe("2024-01-15");
    expect(normalizeToIsoDate("2025-12-31")).toBe("2025-12-31");
  });

  it("accepts Perplexity format and converts to ISO", () => {
    expect(normalizeToIsoDate("1/15/2024")).toBe("2024-01-15");
    expect(normalizeToIsoDate("12/31/2025")).toBe("2025-12-31");
  });

  it("rejects invalid formats", () => {
    expect(normalizeToIsoDate("01-15-2024")).toBeUndefined();
    expect(normalizeToIsoDate("2024/01/15")).toBeUndefined();
    expect(normalizeToIsoDate("invalid")).toBeUndefined();
  });

  it("converts ISO to Perplexity format", () => {
    expect(isoToPerplexityDate("2024-01-15")).toBe("1/15/2024");
    expect(isoToPerplexityDate("2025-12-31")).toBe("12/31/2025");
    expect(isoToPerplexityDate("2024-03-05")).toBe("3/5/2024");
  });

  it("rejects invalid ISO dates", () => {
    expect(isoToPerplexityDate("1/15/2024")).toBeUndefined();
    expect(isoToPerplexityDate("invalid")).toBeUndefined();
  });
});

describe("web_search time filter parsing", () => {
  const baseMessages = {
    invalidFreshnessMessage: "bad freshness",
    invalidDateAfterMessage: "bad after",
    invalidDateBeforeMessage: "bad before",
    invalidDateRangeMessage: "bad range",
  };

  it("normalizes freshness shortcuts for providers", () => {
    expect(
      parseWebSearchTimeFilters({
        rawFreshness: "pd",
        freshnessProvider: "perplexity",
        ...baseMessages,
      }),
    ).toEqual({ freshness: "day" });
  });

  it("rejects conflicting freshness and date filters", () => {
    expect(
      parseWebSearchTimeFilters({
        rawFreshness: "week",
        rawDateAfter: "2026-01-01",
        freshnessProvider: "brave",
        ...baseMessages,
      }),
    ).toEqual({
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("parses date bounds through the shared ISO range validator", () => {
    expect(
      parseWebSearchTimeFilters({
        rawDateAfter: "2026-01-01",
        rawDateBefore: "2026-01-31",
        freshnessProvider: "brave",
        ...baseMessages,
      }),
    ).toEqual({ dateAfter: "2026-01-01", dateBefore: "2026-01-31" });
  });
});

describe("web_search unsupported filter response", () => {
  it("returns undefined when no unsupported filter is set", () => {
    expect(buildUnsupportedSearchFilterResponse({ query: "openclaw" }, "gemini")).toBeUndefined();
  });

  it("maps non-date filters to provider-specific unsupported errors", () => {
    expect(buildUnsupportedSearchFilterResponse({ country: "us" }, "grok")).toEqual({
      error: "unsupported_country",
      message:
        "country filtering is not supported by the grok provider. Only Brave and Perplexity support country filtering.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("collapses date filters to unsupported_date_filter", () => {
    expect(buildUnsupportedSearchFilterResponse({ date_before: "2026-03-19" }, "kimi")).toEqual({
      error: "unsupported_date_filter",
      message:
        "date_after/date_before filtering is not supported by the kimi provider. Only Brave and Perplexity support date filtering.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });
});

describe("web_search scoped config merge", () => {
  it("returns the original config when no plugin config exists", () => {
    const searchConfig = { provider: "grok", grok: { model: "grok-4-1-fast" } };
    expect(mergeScopedSearchConfig(searchConfig, "grok", undefined)).toBe(searchConfig);
  });

  it("merges plugin config into the scoped provider object", () => {
    expect(
      mergeScopedSearchConfig({ provider: "grok", grok: { model: "old-model" } }, "grok", {
        model: "new-model",
        apiKey: "xai-test-key",
      }),
    ).toEqual({
      provider: "grok",
      grok: { model: "new-model", apiKey: "xai-test-key" },
    });
  });

  it("can mirror the plugin apiKey to the top level config", () => {
    expect(
      mergeScopedSearchConfig(
        { provider: "brave", brave: { count: 5 } },
        "brave",
        { apiKey: "brave-test-key" },
        { mirrorApiKeyToTopLevel: true },
      ),
    ).toEqual({
      provider: "brave",
      apiKey: "brave-test-key",
      brave: { count: 5, apiKey: "brave-test-key" },
    });
  });

  it("keeps mirrored Brave plugin config runtime-only when newly injected", () => {
    const merged = mergeScopedSearchConfig(
      { provider: "brave" },
      "brave",
      { apiKey: "brave-test-key" },
      { mirrorApiKeyToTopLevel: true },
    );

    expect(merged?.brave).toEqual({ apiKey: "brave-test-key" });
    expect(merged?.apiKey).toBe("brave-test-key");
    // Injected provider detail is available to runtime validation but hidden
    // from ordinary config serialization.
    expect(Object.keys(merged ?? {})).toEqual(["provider", "apiKey"]);
    expect(Object.getOwnPropertyDescriptor(merged, "brave")?.enumerable).toBe(false);
  });

  it("keeps newly injected legacy provider config runtime-only for validation", () => {
    const merged = mergeScopedSearchConfig({ enabled: true, provider: "gemini" }, "perplexity", {
      apiKey: "perplexity-test-key",
    });

    expect(merged?.perplexity).toEqual({ apiKey: "perplexity-test-key" });
    expect(Object.keys(merged ?? {})).toEqual(["enabled", "provider"]);

    expect(Object.getOwnPropertyDescriptor(merged, "perplexity")?.enumerable).toBe(false);
  });
});

describe("web_search tool schema reflects the active provider", () => {
  // unit-fast shares globals across files; always restore an empty registry.
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function registerProviderWithSchema(parameters: Record<string, unknown>): void {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      source: "test",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom provider",
        envVars: [],
        placeholder: "custom-...",
        signupUrl: "https://example.com",
        autoDetectOrder: 1,
        credentialPath: "tools.web.search.custom.apiKey",
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "custom tool",
          parameters,
          execute: async () => ({ ok: true }),
        }),
      },
    });
    setActivePluginRegistry(registry);
  }

  it("advertises the selected provider's own parameter schema", () => {
    registerProviderWithSchema({
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        custom_knob: { type: "string", description: "provider-specific knob" },
      },
    });

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "custom" } } } },
    });
    const parameters = tool?.parameters as { properties?: Record<string, unknown> } | undefined;
    const properties = parameters?.properties;

    // Provider-owned schema is surfaced verbatim; core no longer hardcodes it.
    expect(properties?.custom_knob).toBeDefined();
  });

  it("falls back to the back-compat superset when no provider is active", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "custom" } } } },
    });
    const parameters = tool?.parameters as { properties?: Record<string, unknown> } | undefined;
    const properties = parameters?.properties;

    // Fallback keeps every historically shipped parameter (Brave/Perplexity
    // knobs included) so nothing is lost when no provider is active; unknown
    // provider-specific knobs still do not leak in.
    expect(properties?.country).toBeDefined();
    expect(properties?.search_lang).toBeDefined();
    expect(properties?.custom_knob).toBeUndefined();
  });

  it("does not advertise a backup provider's schema for an explicitly selected unavailable provider", () => {
    // runWebSearch throws (no fallback) when an explicitly configured provider
    // is unavailable, so the schema must not leak a different provider's
    // parameters. It falls back to the superset instead.
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push(
      {
        pluginId: "unavailable-search",
        pluginName: "Unavailable Search",
        source: "test",
        provider: {
          id: "unavailable",
          label: "Unavailable Search",
          hint: "Unavailable provider",
          envVars: [],
          placeholder: "unavailable-...",
          signupUrl: "https://example.com",
          autoDetectOrder: 1,
          credentialPath: "tools.web.search.unavailable.apiKey",
          getCredentialValue: () => "configured",
          setCredentialValue: () => {},
          createTool: () => null,
        },
      },
      {
        pluginId: "backup-search",
        pluginName: "Backup Search",
        source: "test",
        provider: {
          id: "backup",
          label: "Backup Search",
          hint: "Backup provider",
          envVars: [],
          placeholder: "backup-...",
          signupUrl: "https://example.com",
          autoDetectOrder: 2,
          credentialPath: "tools.web.search.backup.apiKey",
          getCredentialValue: () => "configured",
          setCredentialValue: () => {},
          createTool: () => ({
            description: "backup tool",
            parameters: {
              type: "object",
              required: ["query"],
              properties: {
                query: { type: "string" },
                backup_knob: { type: "string" },
              },
            },
            execute: async () => ({ ok: true }),
          }),
        },
      },
    );
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "unavailable" } } } },
    });
    const parameters = tool?.parameters as { properties?: Record<string, unknown> } | undefined;
    const properties = parameters?.properties;

    // Explicit selection never falls back to another provider: no backup_knob.
    expect(properties?.backup_knob).toBeUndefined();
    // Superset fallback is advertised instead so the model keeps usable filters.
    expect(properties?.country).toBeDefined();
    expect(properties?.search_lang).toBeDefined();
  });

  function makeProviderEntry(opts: {
    id: string;
    autoDetectOrder: number;
    signal: boolean;
    schema: Record<string, unknown> | null;
  }) {
    return {
      pluginId: `${opts.id}-search`,
      pluginName: `${opts.id} Search`,
      source: "test",
      provider: {
        id: opts.id,
        label: `${opts.id} Search`,
        hint: `${opts.id} provider`,
        requiresCredential: opts.signal ? undefined : false,
        envVars: [],
        placeholder: `${opts.id}-...`,
        signupUrl: "https://example.com",
        autoDetectOrder: opts.autoDetectOrder,
        credentialPath: `tools.web.search.${opts.id}.apiKey`,
        getConfiguredCredentialValue: () => (opts.signal ? "configured-key" : undefined),
        getCredentialValue: () => (opts.signal ? "configured-key" : undefined),
        setCredentialValue: () => {},
        createTool: () =>
          opts.schema === null
            ? null
            : {
                description: `${opts.id} tool`,
                parameters: opts.schema,
                execute: async () => ({ ok: true }),
              },
      },
    } as never;
  }

  const backupSchema = {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" }, backup_knob: { type: "string" } },
  };

  it("does not advertise an unconfigured backup provider's schema during auto-detect", () => {
    // Auto-detect only falls through to providers execution would try
    // (hasImplicitProviderSelectionSignal). The preferred provider has a
    // credential signal but is unavailable; the backup has no signal, so its
    // schema must not be advertised.
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push(
      makeProviderEntry({ id: "preferred", autoDetectOrder: 1, signal: true, schema: null }),
      makeProviderEntry({ id: "backup", autoDetectOrder: 2, signal: false, schema: backupSchema }),
    );
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { enabled: true } } } },
    });
    const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;

    expect(properties?.backup_knob).toBeUndefined();
    expect(properties?.country).toBeDefined();
  });

  it("advertises a configured backup provider's schema during auto-detect fallback", () => {
    // A backup provider that execution would try (has a credential signal) is
    // advertised when the preferred provider is unavailable.
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push(
      makeProviderEntry({ id: "preferred", autoDetectOrder: 1, signal: true, schema: null }),
      makeProviderEntry({ id: "backup", autoDetectOrder: 2, signal: true, schema: backupSchema }),
    );
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { enabled: true } } } },
    });
    const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;

    expect(properties?.backup_knob).toBeDefined();
  });
});

export type RuntimeWebDiagnosticCode =
  | "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT"
  | "WEB_SEARCH_AUTODETECT_SELECTED"
  | "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK"
  | "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK";

export type RuntimeWebDiagnostic = {
  code: RuntimeWebDiagnosticCode;
  message: string;
  path?: string;
};

export type RuntimeWebSearchMetadata = {
  providerConfigured?: string;
  providerSource: "configured" | "auto-detect" | "none";
  selectedProvider?: string;
  selectedProviderKeySource?: "config" | "secretRef" | "env" | "missing";
  perplexityTransport?: "search_api" | "chat_completions";
  diagnostics: RuntimeWebDiagnostic[];
};

export type RuntimeWebFetchFirecrawlMetadata = {
  active: boolean;
  apiKeySource: "config" | "secretRef" | "env" | "missing";
  diagnostics: RuntimeWebDiagnostic[];
};

export type RuntimeWebToolsMetadata = {
  search: RuntimeWebSearchMetadata;
  fetch: {
    firecrawl: RuntimeWebFetchFirecrawlMetadata;
  };
  diagnostics: RuntimeWebDiagnostic[];
};

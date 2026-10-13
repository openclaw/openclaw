import { formatToolExecutionErrorMessage } from "../agents/tool-result-error.js";
import { diagnosticHttpStatusCode } from "../infra/diagnostic-error-metadata.js";
import type { RunWebSearchResult } from "./runtime-types.js";

/** Keeps provider attribution and the original diagnostic across automatic fallback. */
export class WebSearchProviderError extends Error {
  constructor(
    readonly provider: string,
    cause: unknown,
  ) {
    super(formatToolExecutionErrorMessage(cause, "Search provider failed."), { cause });
    this.name = "WebSearchProviderError";
  }

  /** Model-facing diagnostics contain no upstream response body or credentials. */
  toResult(): RunWebSearchResult {
    const status = diagnosticHttpStatusCode(this.cause);
    const hint =
      status === "401" || status === "403"
        ? "Check this search provider's credentials and access, or choose another provider."
        : status === "429"
          ? "Check this search provider's quota or try again later."
          : "Check this search provider's configuration and connection, or choose another provider.";
    return {
      provider: this.provider,
      result: {
        error: "provider_error",
        message: `Search failed${status ? ` (HTTP ${status})` : ""}. ${hint}`,
        docs: "https://docs.openclaw.ai/tools/web",
      },
    };
  }
}

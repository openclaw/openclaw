import { isSignalTimeoutReason } from "../agents/failover/error.js";
import { formatToolExecutionErrorMessage } from "../agents/tool-result-error.js";
import { diagnosticHttpStatusCode } from "../infra/diagnostic-error-metadata.js";
import type { RunWebSearchResult } from "./runtime-types.js";

/** Providers report absent credentials as structured `missing_<provider>_api_key` output. */
export function isMissingCredentialCode(code: unknown): code is string {
  return typeof code === "string" && /^missing_[a-z0-9_]*api_key$/i.test(code);
}

/**
 * Core-authored, so it stays outside the untrusted envelope: missing credentials are a
 * lasting setup fact, and models otherwise retry or reword queries that cannot succeed.
 */
export function formatWebSearchNotConfiguredMessage(provider: string): string {
  return (
    `web_search is not set up: provider "${provider}" has no credentials on this Gateway. ` +
    "Searching again or rewording the query fails the same way until the operator configures it. " +
    "Use another available route instead, such as fetching a known URL or a browser, if this session has one, and tell the user if search was needed."
  );
}

/** Keeps provider attribution and the original diagnostic across automatic fallback. */
export class WebSearchProviderError extends Error {
  constructor(
    readonly provider: string,
    cause: unknown,
    /** The provider's structured `missing_*_api_key` result, kept for the tool boundary. */
    readonly missingCredentialResult?: Record<string, unknown>,
  ) {
    super(formatToolExecutionErrorMessage(cause, "Search provider failed."), { cause });
    this.name = "WebSearchProviderError";
  }

  /** Model-facing diagnostics contain no upstream response body or credentials. */
  toResult(): RunWebSearchResult {
    if (this.missingCredentialResult) {
      // The tool boundary adds the not-configured guidance for this result.
      return { provider: this.provider, result: this.missingCredentialResult };
    }
    const status = diagnosticHttpStatusCode(this.cause);
    let message: string;
    if (!status && isSignalTimeoutReason(this.cause)) {
      // Only a numeric budget crosses the boundary; never parse upstream diagnostic prose.
      const timeoutMs: unknown =
        this.cause instanceof Error
          ? Object.getOwnPropertyDescriptor(this.cause, "timeoutMs")?.value
          : undefined;
      const bound =
        typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
          ? ` after ${timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`}`
          : "";
      message = `Search timed out${bound}. Try again later or choose another provider.`;
    } else {
      const hint =
        status === "401" || status === "403"
          ? "Check this search provider's credentials and access, or choose another provider."
          : status === "429"
            ? "Check this search provider's quota or try again later."
            : "Check this search provider's configuration and connection, or choose another provider.";
      message = `Search failed${status ? ` (HTTP ${status})` : ""}. ${hint}`;
    }
    return {
      provider: this.provider,
      result: {
        error: "provider_error",
        message,
        docs: "https://docs.openclaw.ai/tools/web",
      },
    };
  }
}

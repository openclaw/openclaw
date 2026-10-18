import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailureError,
} from "../agents/auth-profiles/oauth-refresh-failure.js";
import { isSignalTimeoutReason } from "../agents/failover/error.js";
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
    const oauthFailure = classifyOAuthRefreshFailureError(this.cause);
    const status = diagnosticHttpStatusCode(this.cause);
    let message: string;
    if (oauthFailure) {
      // Provider id and login command only: profile ids can name the signed-in account.
      const signIn = oauthFailure.provider ? `${oauthFailure.provider} sign-in` : "sign-in";
      const state = oauthFailure.reason
        ? "expired and could not be refreshed"
        : "could not be refreshed";
      const chatLogin = buildOAuthRefreshFailureLoginCommand(oauthFailure.provider, {
        surface: "chat",
      });
      // Facts only: the model decides whether the outage is worth mentioning.
      message =
        `Search failed: this search provider's ${signIn} ${state}. ` +
        `The Gateway owner can fix it by sending \`${chatLogin}\` in a private chat or Control UI session, ` +
        `or by running \`${buildOAuthRefreshFailureLoginCommand(oauthFailure.provider)}\`. ` +
        "Other routes, such as web_fetch, may still work.";
    } else if (!status && isSignalTimeoutReason(this.cause)) {
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

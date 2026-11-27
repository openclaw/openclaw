import { randomBytes } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import {
  ProviderAuthFailure,
  providerAuthFailureFromOAuthError,
} from "../plugins/provider-auth-failure.js";
import { generatePkceVerifierChallenge } from "./oauth-utils.js";
export { oauthErrorHtml, oauthSuccessHtml } from "../shared/oauth-page.js";
export {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  isRecoverableOAuthRefreshFailure,
  readOAuthRefreshErrorReason,
  type OAuthRefreshOutcome,
  type OAuthRefreshErrorReason,
} from "../shared/oauth-refresh-outcome.js";

export { CODEX_CLI_PROFILE_ID } from "../agents/auth-profiles/profile-ids.js";
export { isFailedOAuthRefreshFence } from "../agents/auth-profiles/oauth-refresh-marker.js";
export {
  decodeOpenAICodexJwtPayload,
  resolveOpenAICodexAuthIdentity,
} from "./provider-openai-chatgpt-auth.js";

export type {
  OAuthCredentials,
  OAuthProviderId,
  OAuthProvider,
  OAuthPrompt,
  OAuthAuthInfo,
  OAuthSelectOption,
  OAuthSelectPrompt,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
  OAuthProviderInfo,
} from "../llm/utils/oauth/types.js";

/** Generates an OAuth PKCE verifier and SHA-256 challenge using base64url encoding. */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  return generatePkceVerifierChallenge();
}

/** Generates a random base64url OAuth state value for CSRF protection. */
export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * @deprecated Shipped public type (v2026.11.6); `parseOAuthAuthorizationInput` now always
 * returns a code. Kept for existing plugin imports.
 */
export type OAuthAuthorizationInput = {
  /** Authorization code parsed from a callback URL, query string, or pasted code. */
  code?: string;
  /** Optional OAuth state parsed from callback URL, query string, or `code#state` input. */
  state?: string;
};

/**
 * The one paste parser for browser sign-in. Accepts a full redirect address, its query
 * string, `code#state` or a bare code. A pasted state must match `expected.state`; a bare
 * code carries none, and PKCE still binds it to this attempt because only this attempt's
 * verifier can exchange it. Throws `ProviderAuthFailure` for a refusal or a paste that
 * cannot answer this sign-in, so prompt validators can show its message and stay open.
 */
export function parseOAuthAuthorizationInput(
  input: string,
  expected: { state?: string; signInUrl?: string },
): { code: string; state?: string };
/**
 * @deprecated Pass `expected` for validation. The shipped one-argument call (v2026.11.6) never
 * throws: input without a usable code returns `{}` so existing callers keep prompting.
 */
export function parseOAuthAuthorizationInput(input: string): OAuthAuthorizationInput;
export function parseOAuthAuthorizationInput(
  input: string,
  expected?: { state?: string; signInUrl?: string },
): OAuthAuthorizationInput {
  if (!expected) {
    try {
      return parseOAuthAuthorizationInput(input, {});
    } catch (error) {
      if (error instanceof ProviderAuthFailure) {
        return {};
      }
      throw error;
    }
  }
  const value = input.trim();
  const url = URL.parse(value);
  const signIn = expected.signInUrl ? URL.parse(expected.signInUrl) : null;
  if (url && signIn && url.origin === signIn.origin && url.pathname === signIn.pathname) {
    throw new ProviderAuthFailure("paste_sign_in_page");
  }
  let params = url?.searchParams;
  let code: string | undefined;
  let state: string | undefined;
  if (url) {
    // Redirect addresses carry the answer in the query string.
  } else if (/(?:^|[?&])(?:code|state|error)=/.test(value)) {
    params = new URLSearchParams(value);
  } else {
    [code, state] = value.split("#", 2);
  }
  code = (params ? params.get("code") : code)?.trim() || undefined;
  state = (params ? params.get("state") : state)?.trim() || undefined;
  if (state && expected.state && state !== expected.state) {
    throw new ProviderAuthFailure("paste_wrong_attempt");
  }
  const error = params?.get("error");
  if (error) {
    throw providerAuthFailureFromOAuthError(error);
  }
  if (!code) {
    throw new ProviderAuthFailure("paste_no_code");
  }
  return state ? { code, state } : { code };
}

/** Converts provider `expires_in` seconds into safe positive milliseconds. */
export function resolveOAuthTokenLifetimeMs(
  /** Provider `expires_in` value in seconds. */
  value: unknown,
): number | undefined {
  return positiveSecondsToSafeMilliseconds(value);
}

/** Resolves provider token lifetime into an absolute expiry timestamp with optional refresh skew. */
export function resolveOAuthTokenExpiresAt(
  /** Provider `expires_in` value in seconds. */
  value: unknown,
  options: {
    /** Current timestamp override for deterministic expiry calculations. */
    nowMs?: number;
    /** Milliseconds to subtract so refresh happens before provider expiry. */
    refreshSkewMs?: number;
  } = {},
): number | undefined {
  const lifetimeMs = resolveOAuthTokenLifetimeMs(value);
  return lifetimeMs === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(lifetimeMs, {
        nowMs: options.nowMs,
        bufferMs: options.refreshSkewMs,
      });
}

/**
 * Creates the shared cancellation error used by abortable OAuth login flows.
 */
export function createOAuthLoginCancelledError(): Error {
  return new Error("Login cancelled");
}

/** Throws the shared OAuth cancellation error when a login signal is already aborted. */
export function throwIfOAuthLoginAborted(
  /** Abort signal attached to the OAuth login flow. */
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw createOAuthLoginCancelledError();
  }
}

/** Races a pending OAuth login step against the login abort signal and normalizes rejections. */
export function withOAuthLoginAbort<T>(
  /** Pending OAuth login operation to race against abort. */
  promise: Promise<T>,
  /** Abort signal attached to the OAuth login flow. */
  signal?: AbortSignal,
  /** Optional cleanup hook called when the login is aborted. */
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  return racePromiseWithAbortSignal(promise, signal, () => {
    onAbort?.();
    return createOAuthLoginCancelledError();
  }).catch((error: unknown) => {
    throw toErrorObject(error, "Non-Error rejection");
  });
}

/** Combines a caller abort signal with a bounded timeout signal for OAuth HTTP requests. */
export function buildOAuthRequestSignal(options: {
  /** Optional caller-provided signal to combine with the timeout signal. */
  signal?: AbortSignal;
  /** Request timeout in milliseconds before the generated signal aborts. */
  timeoutMs: number;
}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(resolveTimerTimeoutMs(options.timeoutMs, 0, 0));
  if (!options.signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([options.signal, timeoutSignal]);
}

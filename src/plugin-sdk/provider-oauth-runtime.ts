import { randomBytes } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "../../packages/normalization-core/src/number-coercion.js";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import type { OAuthAuthorizationInput } from "../llm/utils/oauth/types.js";
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
  OAuthAuthorizationInput,
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
function generateBase64UrlOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export { generateBase64UrlOAuthState as generateOAuthState };

/**
 * Parses callback URLs, raw query strings, `code#state`, or plain pasted codes.
 * Empty input returns an empty object so callers can keep prompting.
 */
export function parseOAuthAuthorizationInput(
  /** Raw callback URL, query string, `code#state`, or pasted code. */
  input: string,
): OAuthAuthorizationInput {
  const value = input.trim();
  if (!value) {
    return {};
  }

  const url = URL.parse(value);
  if (url) {
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
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

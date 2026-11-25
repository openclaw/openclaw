// Provider auth runtime helpers implement OAuth loopback, token exchange, and auth persistence.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
} from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  startOAuthLoopbackCallbackServer,
  type OAuthLoopbackCallbackServer,
} from "../infra/oauth-loopback-callback.js";
import {
  providerAuthFailureFromOAuthError,
  type ProviderAuthFailureReason,
} from "../plugins/provider-auth-failure.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { renderOAuthPage } from "../shared/oauth-page.js";
import { parseOAuthAuthorizationInput } from "./provider-oauth-runtime.js";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export { withPersonalAuthProfileStore } from "../agents/auth-profiles/personal-store.js";
export { withAuthProfileStoreAtEffect } from "../agents/auth-profiles/store-runtime.js";
export { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
export { removeProviderAuthProfilesWithLock } from "../agents/auth-profiles/profiles.js";
export { removeAuthProfileConfig } from "../plugins/provider-auth-helpers.js";
export {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
export {
  isProviderAuthError,
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";

/**
 * OAuth authorization code and state captured by the local callback listener.
 */
export type OAuthCallbackResult = {
  /** Authorization code returned by the OAuth provider callback. */
  code: string;
  /** State value returned by the callback and validated against the expected state. */
  state: string;
};

/**
 * Binds a hardened loopback listener before returning so provider plugins can open the browser
 * only after the callback route is ready. Invalid request candidates remain nonterminal.
 */
export async function startProviderOAuthLoopbackCallbackServer(
  params: Parameters<typeof startOAuthLoopbackCallbackServer>[0],
): Promise<OAuthLoopbackCallbackServer> {
  return await startOAuthLoopbackCallbackServer(params);
}

/**
 * Non-secret auth profile metadata used by provider discovery helpers.
 */
export type ProviderAuthProfileMetadata = {
  profileId?: string;
  accountId?: string;
};

/** @deprecated Use resolveProviderAuthProfileMetadataAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveProviderAuthProfileMetadata(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  agentDir?: string;
}): ProviderAuthProfileMetadata {
  warnPluginSdkDeprecation({
    family: "auth-profiles",
    method: "resolveProviderAuthProfileMetadata",
    replacement: "resolveProviderAuthProfileMetadataAsync",
  });
  const store = ensureAuthProfileStore(params.agentDir, {
    config: params.cfg,
    readOnly: true,
  });
  return selectProviderAuthProfileMetadata(params, store);
}

export async function resolveProviderAuthProfileMetadataAsync(
  params: Parameters<typeof resolveProviderAuthProfileMetadata>[0],
): Promise<ProviderAuthProfileMetadata> {
  const store = await ensureAuthProfileStoreAsync(params.agentDir, {
    config: params.cfg,
    readOnly: true,
  });
  return selectProviderAuthProfileMetadata(params, store);
}

function selectProviderAuthProfileMetadata(
  params: Parameters<typeof resolveProviderAuthProfileMetadata>[0],
  store: AuthProfileStore,
): ProviderAuthProfileMetadata {
  const normalizedProvider = normalizeProviderId(params.provider);
  const entry = params.profileId
    ? ([params.profileId, store.profiles[params.profileId]] as const)
    : Object.entries(store.profiles).find(
        ([, profile]) => normalizeProviderId(profile.provider) === normalizedProvider,
      );
  const [profileId, profile] = entry ?? [];
  if (!profile) {
    return {};
  }
  return {
    profileId,
    ...(profile.type === "oauth" && profile.accountId ? { accountId: profile.accountId } : {}),
  };
}

// IdP-host allowlist for CORS echo on the loopback OAuth callback. Plugins
// pass the hosts that may legitimately issue preflights against the redirect
// URI; everything else gets a 204 with no `Access-Control-Allow-*` headers,
// which is safe for normal browser navigation but blocks cross-origin script
// reads. The empty allowlist (default) leaves the legacy permissive SDK
// behavior in place for existing callers.
export function buildOAuthCallbackOriginResolver(
  /** HTTPS IdP hosts allowed to receive a CORS echo from the loopback callback. */
  allowedHosts: readonly string[] | undefined,
): (originHeader: string | string[] | undefined) => string | undefined {
  if (!allowedHosts || allowedHosts.length === 0) {
    return () => undefined;
  }
  const normalized = new Set(
    allowedHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  );
  if (normalized.size === 0) {
    return () => undefined;
  }
  return (originHeader) => {
    const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!value) {
      return undefined;
    }
    const parsed = URL.parse(value);
    return parsed?.protocol === "https:" && normalized.has(parsed.host.toLowerCase())
      ? parsed.origin
      : undefined;
  };
}

/**
 * @deprecated Use `generateOAuthState` from `openclaw/plugin-sdk/provider-oauth-runtime`.
 * Kept because published ClawHub plugins import it here (4 at 2026-11-21); the state is opaque.
 */
export { generateOAuthState } from "./provider-oauth-runtime.js";

/**
 * @deprecated Use `parseOAuthAuthorizationInput` from `openclaw/plugin-sdk/provider-oauth-runtime`.
 * Kept because published ClawHub plugins import it here (5 at 2026-11-21). Same rules as the one
 * paste parser, plus the old requirement that a state is present.
 */
export function parseOAuthCallbackInput(
  input: string,
  messages: { missingState?: string; invalidInput?: string } = {},
): OAuthCallbackResult | { error: string } {
  if (!URL.parse(input.trim())) {
    return { error: messages.invalidInput ?? "Paste the full redirect URL, not just the code." };
  }
  try {
    const { code, state } = parseOAuthAuthorizationInput(input, {});
    return state
      ? { code, state }
      : { error: messages.missingState ?? "Missing 'state' parameter in URL" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Starts a temporary loopback HTTP listener and waits for a validated OAuth callback.
 */
export async function waitForLocalOAuthCallback(params: {
  /** State token that the callback must echo before the listener resolves. */
  expectedState: string;
  /** Maximum wait time before the listener rejects. */
  timeoutMs: number;
  /** Loopback port to bind for the temporary callback server. */
  port: number;
  /** URL path accepted as the OAuth callback endpoint. */
  callbackPath: string;
  /** Redirect URI shown in progress messages and provider setup flows. */
  redirectUri: string;
  /** HTML success heading rendered after a valid callback. */
  successTitle: string;
  /** Optional progress message emitted once the listener starts. */
  progressMessage?: string;
  /** Extra loopback hostname to bind; the redirect URI hostname is always bound. */
  hostname?: string;
  /** Progress callback; `reason` names a provider refusal that keeps the listener open. */
  onProgress?: (message: string, reason?: ProviderAuthFailureReason) => void;
  /** Stops and closes the callback listener when the owning login is cancelled. */
  signal?: AbortSignal;
  /**
   * IdP hosts allowed to receive CORS echo on loopback callback preflights.
   */
  corsOriginAllowlist?: readonly string[];
}): Promise<OAuthCallbackResult> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const callbackUrl = new URL(params.redirectUri);
  callbackUrl.port = String(params.port);
  callbackUrl.pathname = params.callbackPath;
  const resolveOAuthCallbackOrigin = buildOAuthCallbackOriginResolver(params.corsOriginAllowlist);
  const hasCorsOriginAllowlist =
    params.corsOriginAllowlist?.some((host) => host.trim().length > 0) ?? false;
  const callback = await startOAuthLoopbackCallbackServer({
    redirectUrl: callbackUrl,
    expectedState: params.expectedState,
    timeoutMs,
    ...(params.hostname ? { bindHostname: params.hostname } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    // A refusal keeps the listener open so the user can go back and allow access.
    ...(params.onProgress
      ? {
          onRefusal: (error) => {
            const failure = providerAuthFailureFromOAuthError(error);
            params.onProgress?.(failure.message, failure.reason);
          },
        }
      : {}),
    resolveCorsOrigin: hasCorsOriginAllowlist
      ? resolveOAuthCallbackOrigin
      : (originHeader) => {
          const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
          return value && isHttpOrigin(value) ? value : undefined;
        },
    renderSuccess: () => ({
      body: renderOAuthPage({
        title: params.successTitle,
        heading: params.successTitle,
        message: "You can close this window and return to OpenClaw.",
      }),
      contentType: "text/html; charset=utf-8",
    }),
  });
  try {
    params.onProgress?.(
      params.progressMessage ?? `Waiting for OAuth callback on ${params.redirectUri}...`,
    );
    const result = await callback.waitForCallback();
    if (result.type === "oauth_error") {
      throw providerAuthFailureFromOAuthError(result.error);
    }
    return { code: result.code, state: result.state };
  } finally {
    await callback.close();
  }
}

function isHttpOrigin(value: string): boolean {
  const url = URL.parse(value);
  return (url?.protocol === "http:" || url?.protocol === "https:") && url.origin === value;
}

type ResolveApiKeyForProvider =
  typeof import("../agents/model-auth-provider.js").resolveApiKeyForProviderCore;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModelCore;

/**
 * Resolves provider API-key auth without loading model-runtime preparation.
 */
export async function resolveApiKeyForProvider(
  /** Provider auth lookup params forwarded to the provider auth owner. */
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  params.signal?.throwIfAborted();
  const { resolveApiKeyForProviderCore } = await import("../agents/model-auth-provider.js");
  params.signal?.throwIfAborted();
  return resolveApiKeyForProviderCore(params);
}

/**
 * Resolves the prepared runtime auth payload for a concrete model request.
 */
export async function getRuntimeAuthForModel(
  /** Concrete model auth request forwarded to the runtime auth module. */
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModelCore: getRuntimeAuthForModelLocal } =
    await import("../plugins/runtime/runtime-model-auth.runtime.js");
  return getRuntimeAuthForModelLocal(params);
}

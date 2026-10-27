import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import type { GatewayAuthConfig, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { createLazyPromise, getOrCreatePromise } from "../shared/lazy-promise.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { resolveCanonicalCachedGitHubIdentity } from "../state/user-profile-reads.js";
import {
  ensureCanonicalEnterpriseGitHubProfile,
  ensureCanonicalUserProfileForEmail,
  syncCanonicalGitHubIdentity,
} from "../state/user-profile-writes.js";
import { classifyTailscaleLogin } from "../state/user-profiles-tailscale-login.js";
import type { CachedGitHubIdentityBinding } from "../state/user-profiles.types.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import type { GatewayAuthResult } from "./auth.js";
import { gitHubPublicApi, githubApiToken } from "./github-public-api.js";
import type { AuthenticatedGitHubIdentitySync } from "./github-user-identity.types.js";
import { firstHeaderValue } from "./http-header-value.js";

const CLOUDFLARE_ACCESS_USER_HEADER = "cf-access-authenticated-user-email";
const CLOUDFLARE_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const CLOUDFLARE_ACCESS_HOST_SUFFIX = ".cloudflareaccess.com";
const CLOUDFLARE_ACCESS_IDENTITY_PATH = "/cdn-cgi/access/get-identity";
const ACCESS_ASSERTION_MAX_BYTES = 16 * 1024;
const ACCESS_IDENTITY_MAX_BYTES = 64 * 1024;
const ACCESS_IDENTITY_CACHE_MS = 5 * 60_000;
const ACCESS_IDENTITY_CACHE_LIMIT = 200;
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const GITHUB_IDENTITY_CACHE_MS = 15 * 60_000;
const GITHUB_IDENTITY_CACHE_LIMIT = 200;
const GITHUB_ETAG_MAX_LENGTH = 1_024;

type ResolvedGitHubUserIdentity = { accountId: number; login: string; name?: string };
type ResolvedCloudflareAccessIdentity =
  | { provider: "github"; accountId: number; initialDisplayName?: string }
  | { provider: "oidc"; accountId?: number };
type GitHubIdentityLookup = { identity: ResolvedGitHubUserIdentity; refreshed: boolean };
type GitHubIdentityMetadataCache = {
  values: Map<string, { identity: ResolvedGitHubUserIdentity; expiresAt: number; etag?: string }>;
  pending: Map<string, Promise<ResolvedGitHubUserIdentity>>;
};
const identityMetadataCaches = new WeakMap<typeof fetch, GitHubIdentityMetadataCache>();
const accessIdentityCaches = new WeakMap<
  typeof fetch,
  Map<string, { identity: Promise<ResolvedCloudflareAccessIdentity>; expiresAt: number }>
>();

function cloudflareAccessAssertionClaims(assertion: string): { issuer: URL; expiresAt: number } {
  if (Buffer.byteLength(assertion, "utf8") > ACCESS_ASSERTION_MAX_BYTES) {
    throw new Error("Cloudflare Access assertion is invalid");
  }
  const segments = assertion.split(".");
  if (segments.length !== 3 || segments.some((segment) => !JWT_SEGMENT_PATTERN.test(segment))) {
    throw new Error("Cloudflare Access assertion is invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("Cloudflare Access assertion is invalid");
  }
  if (!isRecord(payload) || typeof payload.iss !== "string") {
    throw new Error("Cloudflare Access assertion issuer is invalid");
  }
  const issuer = URL.parse(payload.iss);
  if (
    !issuer ||
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.port ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash ||
    !issuer.hostname.endsWith(CLOUDFLARE_ACCESS_HOST_SUFFIX)
  ) {
    throw new Error("Cloudflare Access assertion issuer is invalid");
  }
  return {
    issuer,
    expiresAt:
      typeof payload.exp === "number" && Number.isFinite(payload.exp)
        ? Math.min(payload.exp * 1_000, Date.now() + ACCESS_IDENTITY_CACHE_MS)
        : 0,
  };
}

async function resolveCloudflareAccessIdentity(
  assertion: string,
  authenticatedPrincipal: string,
  oidcConfig?: GatewayTrustedProxyConfig["cloudflareAccessOidc"],
): Promise<ResolvedCloudflareAccessIdentity> {
  const { issuer, expiresAt } = cloudflareAccessAssertionClaims(assertion);
  // Keep the cache key and verification on the same policy across the fetch.
  const oidcPolicy = oidcConfig && { ...oidcConfig };
  const fetchImpl = fetch;
  const load = () =>
    fetchCloudflareAccessIdentity(fetchImpl, issuer, assertion, authenticatedPrincipal, oidcPolicy);
  // The assertion only bounds reuse; Access still verifies it, and each caller's
  // principal and OIDC trust configuration must match the verified result.
  if (expiresAt <= Date.now()) {
    return load();
  }
  const key = createHash("sha256")
    .update(JSON.stringify([assertion, authenticatedPrincipal.trim().toLowerCase(), oidcPolicy]))
    .digest("hex");
  const cache: NonNullable<ReturnType<typeof accessIdentityCaches.get>> =
    accessIdentityCaches.get(fetchImpl) ?? new Map();
  accessIdentityCaches.set(fetchImpl, cache);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.identity;
  }
  const identity = load();
  cache.set(key, { identity, expiresAt });
  pruneMapToMaxSize(cache, ACCESS_IDENTITY_CACHE_LIMIT);
  void identity.catch(() => {
    if (cache.get(key)?.identity === identity) {
      cache.delete(key);
    }
  });
  return identity;
}

async function fetchCloudflareAccessIdentity(
  fetchImpl: typeof fetch,
  issuer: URL,
  assertion: string,
  authenticatedPrincipal: string,
  oidcConfig?: GatewayTrustedProxyConfig["cloudflareAccessOidc"],
): Promise<ResolvedCloudflareAccessIdentity> {
  let payload: unknown;
  try {
    const response = await fetchImpl(`${issuer.origin}${CLOUDFLARE_ACCESS_IDENTITY_PATH}`, {
      headers: { Cookie: `CF_Authorization=${assertion}` },
      redirect: "manual",
      signal: AbortSignal.timeout(gitHubPublicApi.GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("identity response was not successful");
    }
    const body = await gitHubPublicApi.readBoundedResponse(response, ACCESS_IDENTITY_MAX_BYTES);
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    // Never attach the underlying fetch error: request errors may retain the bearer cookie.
    throw new Error("Cloudflare Access identity lookup failed");
  }
  if (!isRecord(payload)) {
    throw new Error("Cloudflare Access identity response is invalid");
  }
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email || email.toLowerCase() !== authenticatedPrincipal.trim().toLowerCase()) {
    throw new Error("Cloudflare Access identity principal did not match");
  }
  if (!isRecord(payload.idp)) {
    throw new Error("Cloudflare Access identity provider is invalid");
  }
  if (payload.idp.type === "oidc") {
    const fields = Object.hasOwn(payload, "oidc_fields") ? payload.oidc_fields : payload.custom;
    // A claim name is not an authority: Access must identify the selected issuer and IdP.
    if (
      !oidcConfig ||
      issuer.origin !== oidcConfig.issuer ||
      payload.idp.id !== oidcConfig.providerId ||
      !isRecord(fields) ||
      !Object.hasOwn(fields, oidcConfig.githubAccountIdClaim)
    ) {
      return { provider: "oidc" };
    }
    const claim = fields[oidcConfig.githubAccountIdClaim];
    if (
      typeof claim !== "string" ||
      !/^[1-9][0-9]*$/u.test(claim) ||
      !Number.isSafeInteger(Number(claim))
    ) {
      return { provider: "oidc" };
    }
    return { provider: "oidc", accountId: Number(claim) };
  }
  if (payload.idp.type !== "github") {
    throw new Error("Cloudflare Access identity provider is unsupported");
  }
  if (typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || payload.id <= 0) {
    throw new Error("Cloudflare Access GitHub account id is invalid");
  }
  const initialDisplayName =
    typeof payload.name === "string" && payload.name.trim() ? payload.name : undefined;
  return {
    provider: "github",
    accountId: payload.id,
    ...(initialDisplayName ? { initialDisplayName } : {}),
  };
}

export async function resolveGitHubUserIdentityByLogin(
  username: string,
  options?: { signal?: AbortSignal; allowAnonymousRetry?: boolean },
): Promise<ResolvedGitHubUserIdentity> {
  const requestedLogin = normalizeGitHubLogin(username);
  if (!requestedLogin) {
    throw new TypeError("GitHub username is invalid");
  }
  const token = githubApiToken(process.env, undefined, "github.com");
  let payload: unknown;
  try {
    const request = async (requestToken: string | undefined) => {
      const { value } = await gitHubPublicApi.fetchGitHubJsonPage(
        `${gitHubPublicApi.GITHUB_API_ORIGIN}/users/${encodeURIComponent(requestedLogin)}`,
        fetch,
        requestToken,
        {
          signal: options?.signal,
          apiBaseUrl: gitHubPublicApi.GITHUB_API_ORIGIN,
        },
      );
      return value;
    };
    payload =
      options?.allowAnonymousRetry === false
        ? await request(token)
        : await gitHubPublicApi.withOptionalGitHubAuth(token, request);
  } catch (error) {
    if (error instanceof gitHubPublicApi.ControlUiGitHubError) {
      throw error;
    }
    throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub request failed");
  }
  if (!isRecord(payload)) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub response was not an object");
  }
  const accountId = payload.id;
  if (!Number.isSafeInteger(accountId) || typeof accountId !== "number" || accountId <= 0) {
    throw new gitHubPublicApi.ControlUiGitHubError(
      502,
      "GitHub response omitted a valid account id",
    );
  }
  return parseGitHubUserIdentity(accountId, payload);
}

function parseGitHubUserIdentity(accountId: number, payload: unknown): ResolvedGitHubUserIdentity {
  if (!isRecord(payload) || payload.id !== accountId) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub account id did not match");
  }
  const login = typeof payload.login === "string" ? normalizeGitHubLogin(payload.login) : undefined;
  if (!login) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub response omitted a valid login");
  }
  return { accountId, login, name: readNonBlankString(payload.name) };
}

function resolveGitHubUserIdentityById(
  accountId: number,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<GitHubIdentityLookup> {
  const cache: GitHubIdentityMetadataCache = identityMetadataCaches.get(fetchImpl) ?? {
    values: new Map(),
    pending: new Map(),
  };
  identityMetadataCaches.set(fetchImpl, cache);
  const key = `${accountId}:${gitHubPublicApi.githubApiCredentialCacheScope(token)}`;
  const cached = cache.values.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve({ identity: cached.identity, refreshed: false });
  }
  const promise = getOrCreatePromise(
    cache.pending,
    key,
    async () => {
      try {
        const response = await gitHubPublicApi.fetchGitHubApi(
          `${gitHubPublicApi.GITHUB_API_ORIGIN}/user/${accountId}`,
          fetchImpl,
          token,
          undefined,
          undefined,
          cached?.etag,
          undefined,
          undefined,
          gitHubPublicApi.GITHUB_API_ORIGIN,
        );
        let identity: ResolvedGitHubUserIdentity;
        if (response.status === 304 && cached?.etag) {
          await gitHubPublicApi.discardResponse(response);
          identity = cached.identity;
        } else {
          identity = parseGitHubUserIdentity(
            accountId,
            await gitHubPublicApi.readGitHubJsonResponse(response),
          );
        }
        const rawEtag =
          response.headers.get("etag") ?? (response.status === 304 ? cached?.etag : undefined);
        const etag = rawEtag && rawEtag.length <= GITHUB_ETAG_MAX_LENGTH ? rawEtag : undefined;
        // Cache public metadata, never Access assertions, local profiles, or roles.
        // An evicted in-flight lookup cannot replace its successor's metadata.
        if (cache.pending.get(key) === promise) {
          cache.values.set(key, {
            identity,
            etag,
            expiresAt: Date.now() + GITHUB_IDENTITY_CACHE_MS,
          });
          pruneMapToMaxSize(cache.values, GITHUB_IDENTITY_CACHE_LIMIT);
        }
        return identity;
      } catch (error) {
        if (
          cache.pending.get(key) === promise &&
          error instanceof gitHubPublicApi.ControlUiGitHubError &&
          !error.retryable
        ) {
          cache.values.delete(key);
        }
        throw error;
      }
    },
    { evictOnSettled: true },
  );
  pruneMapToMaxSize(cache.pending, GITHUB_IDENTITY_CACHE_LIMIT);
  return promise.then((identity) => ({ identity, refreshed: true }));
}

/** An Enterprise GitHub principal is authoritative only after trusted-proxy admission. */
export function resolveTrustedEnterpriseGitHubAccountId(params: {
  authResult: Pick<GatewayAuthResult, "ok" | "method" | "user">;
  authConfig?: GatewayAuthConfig;
  config?: OpenClawConfig;
}): number | undefined {
  if (
    !params.authResult.ok ||
    params.authResult.method !== "trusted-proxy" ||
    params.authConfig?.mode !== "trusted-proxy" ||
    normalizeLowercaseStringOrEmpty(params.authConfig.trustedProxy?.userHeader) !==
      "x-factory-principal"
  ) {
    return undefined;
  }
  const principal = parseEnterpriseGitHubPrincipal(params.authResult.user ?? "");
  return principal?.host === resolveConfiguredGitHubHost(params.config)
    ? principal.accountId
    : undefined;
}

export function createAuthenticatedGitHubIdentitySync(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  config?: OpenClawConfig;
  requestHeaders?: IncomingHttpHeaders;
  assertCurrent?: () => void;
}): AuthenticatedGitHubIdentitySync | undefined {
  const options = { assertCurrent: params.assertCurrent };
  // A retryable GitHub outage may reuse only an exact binding verified earlier.
  const reuseVerifiedBinding = async (error: unknown, binding: CachedGitHubIdentityBinding) => {
    if (!(error instanceof gitHubPublicApi.ControlUiGitHubError && error.retryable)) {
      return undefined;
    }
    params.assertCurrent?.();
    const cached = await resolveCanonicalCachedGitHubIdentity(binding);
    params.assertCurrent?.();
    return cached;
  };
  // Metadata is accepted only from the same trusted hop that asserted the immutable account.
  const accountId = resolveTrustedEnterpriseGitHubAccountId(params);
  if (accountId) {
    const rawLogin = firstHeaderValue(params.requestHeaders?.["x-factory-github-login"]);
    const login = rawLogin && rawLogin.length <= 39 ? normalizeGitHubLogin(rawLogin) : undefined;
    const rawName = firstHeaderValue(params.requestHeaders?.["x-factory-github-name"]);
    const name =
      rawName && rawName.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(rawName)
        ? rawName.trim()
        : undefined;
    const rawAvatar = firstHeaderValue(params.requestHeaders?.["x-factory-github-avatar-url"]);
    const email = normalizeVerifiedEmail(params.requestHeaders?.["x-factory-github-email"]);
    let avatarUrl: string | undefined;
    if (rawAvatar && rawAvatar.length <= 512) {
      try {
        const url = new URL(rawAvatar);
        if (
          url.origin === `https://${resolveConfiguredGitHubHost(params.config)}` &&
          url.pathname === `/avatars/u/${accountId}` &&
          !url.username &&
          !url.password &&
          !url.hash
        ) {
          avatarUrl = url.href;
        }
      } catch {
        /* Invalid metadata never grants authority. */
      }
    }
    if (login) {
      return createLazyPromise(async () => {
        params.assertCurrent?.();
        const profile = await ensureCanonicalEnterpriseGitHubProfile(
          params.authResult.user!,
          name || login,
          options,
          { login, email },
        );
        params.assertCurrent?.();
        return {
          profileId: profile.id,
          updatedAt: profile.updatedAt,
          enterprise: {
            accountId,
            login,
            ...(avatarUrl ? { avatarUrl } : {}),
          },
        };
      });
    }
  }
  const tailscaleLogin = params.authResult.tailscaleIdentity
    ? classifyTailscaleLogin(params.authResult.tailscaleIdentity.login)
    : undefined;
  if (tailscaleLogin?.kind === "provider" && tailscaleLogin.provider === "github") {
    return createLazyPromise(async () => {
      params.assertCurrent?.();
      let identity: ResolvedGitHubUserIdentity;
      try {
        identity = await resolveGitHubUserIdentityByLogin(tailscaleLogin.subject);
      } catch (error) {
        const cached = await reuseVerifiedBinding(error, { login: tailscaleLogin.subject });
        if (cached) {
          return cached;
        }
        throw error;
      }
      params.assertCurrent?.();
      const profile = await syncCanonicalGitHubIdentity(
        {
          identity,
          authenticationAlias: { kind: "github-login", login: tailscaleLogin.subject },
          initialDisplayName: params.authResult.tailscaleIdentity?.name,
        },
        options,
      );
      params.assertCurrent?.();
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    });
  }

  const trustedProxy = params.authConfig?.trustedProxy;
  if (
    !params.authResult.ok ||
    params.authResult.method !== "trusted-proxy" ||
    params.authConfig?.mode !== "trusted-proxy" ||
    normalizeLowercaseStringOrEmpty(trustedProxy?.userHeader) !== CLOUDFLARE_ACCESS_USER_HEADER ||
    !trustedProxy?.requiredHeaders?.some(
      (header) => normalizeLowercaseStringOrEmpty(header) === CLOUDFLARE_ACCESS_ASSERTION_HEADER,
    )
  ) {
    return undefined;
  }
  const principal = params.authResult.user?.trim();
  const assertion = firstHeaderValue(
    params.requestHeaders?.[CLOUDFLARE_ACCESS_ASSERTION_HEADER],
  )?.trim();
  if (!principal || !assertion) {
    return undefined;
  }
  return createLazyPromise(async () => {
    params.assertCurrent?.();
    const accessIdentity = await resolveCloudflareAccessIdentity(
      assertion,
      principal,
      params.authConfig?.trustedProxy?.cloudflareAccessOidc,
    );
    params.assertCurrent?.();
    const accessAccountId = accessIdentity.accountId;
    if (accessAccountId === undefined) {
      const profile = await ensureCanonicalUserProfileForEmail(principal, options);
      params.assertCurrent?.();
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    }
    const identityBinding = { accountId: accessAccountId, email: principal };
    // Service auth raises public-data quota; Access still owns the signed-in account id.
    const token = githubApiToken(process.env, undefined, "github.com");
    let lookup: GitHubIdentityLookup;
    try {
      lookup = await gitHubPublicApi.withOptionalGitHubAuth(token, (requestToken) =>
        resolveGitHubUserIdentityById(accessAccountId, requestToken, fetch),
      );
    } catch (error) {
      const cached = await reuseVerifiedBinding(error, identityBinding);
      if (cached) {
        return cached;
      }
      if (accessIdentity.provider === "oidc") {
        params.assertCurrent?.();
        const profile = await ensureCanonicalUserProfileForEmail(principal, {
          ...options,
          expectedGitHubAccountId: accessAccountId,
        });
        params.assertCurrent?.();
        return { profileId: profile.id, updatedAt: profile.updatedAt };
      }
      throw error instanceof gitHubPublicApi.ControlUiGitHubError
        ? error
        : new gitHubPublicApi.ControlUiGitHubError(502, "GitHub request failed");
    }
    params.assertCurrent?.();
    if (!lookup.refreshed) {
      // Re-read the exact current binding: unchanged metadata must not write profiles
      // and broadcast roster changes on each authenticated HTTP request.
      const cached = await resolveCanonicalCachedGitHubIdentity(identityBinding);
      params.assertCurrent?.();
      if (cached) {
        return cached;
      }
    }
    const profile = await syncCanonicalGitHubIdentity(
      {
        identity: lookup.identity,
        authenticationAlias: { kind: "email", email: principal },
        initialDisplayName:
          accessIdentity.provider === "github" ? accessIdentity.initialDisplayName : undefined,
        preserveEmailProfile: accessIdentity.provider === "oidc",
      },
      options,
    );
    params.assertCurrent?.();
    return { profileId: profile.id, updatedAt: profile.updatedAt };
  });
}

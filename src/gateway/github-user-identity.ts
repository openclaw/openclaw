import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayAuthConfig, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createLazyPromise, getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveCachedGitHubIdentity } from "../state/user-profile-github-identity.js";
import { classifyTailscaleLogin } from "../state/user-profiles-tailscale-login.js";
import { ensureProfileForEmail, syncGitHubIdentity } from "../state/user-profiles.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import type { GatewayAuthResult } from "./auth.js";
import { gitHubPublicApi, githubApiToken } from "./github-public-api.js";
import type { AuthenticatedGitHubIdentitySync } from "./github-user-identity.types.js";

const CLOUDFLARE_ACCESS_USER_HEADER = "cf-access-authenticated-user-email";
const CLOUDFLARE_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const CLOUDFLARE_ACCESS_HOST_SUFFIX = ".cloudflareaccess.com";
const CLOUDFLARE_ACCESS_IDENTITY_PATH = "/cdn-cgi/access/get-identity";
const ACCESS_ASSERTION_MAX_BYTES = 16 * 1024;
const ACCESS_IDENTITY_MAX_BYTES = 64 * 1024;
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cloudflareAccessIssuer(assertion: string): URL {
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
  let issuer: URL;
  try {
    issuer = new URL(payload.iss);
  } catch {
    throw new Error("Cloudflare Access assertion issuer is invalid");
  }
  if (
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
  return issuer;
}

async function resolveCloudflareAccessIdentity(
  assertion: string,
  authenticatedPrincipal: string,
  oidcConfig?: GatewayTrustedProxyConfig["cloudflareAccessOidc"],
): Promise<ResolvedCloudflareAccessIdentity> {
  const issuer = cloudflareAccessIssuer(assertion);
  let payload: unknown;
  try {
    const response = await fetch(`${issuer.origin}${CLOUDFLARE_ACCESS_IDENTITY_PATH}`, {
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
    // A claim name is not an authority: Access must identify the selected issuer and IdP.
    if (
      !oidcConfig ||
      issuer.origin !== oidcConfig.issuer ||
      payload.idp.id !== oidcConfig.providerId ||
      !isRecord(payload.oidc_fields) ||
      !Object.hasOwn(payload.oidc_fields, oidcConfig.githubAccountIdClaim)
    ) {
      return { provider: "oidc" };
    }
    const claim = payload.oidc_fields[oidcConfig.githubAccountIdClaim];
    if (
      typeof claim !== "string" ||
      !/^[1-9][0-9]*$/u.test(claim) ||
      !Number.isSafeInteger(Number(claim))
    ) {
      throw new Error("Cloudflare Access OIDC GitHub account id is invalid");
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

async function resolveGitHubUserIdentityByLogin(
  username: string,
): Promise<ResolvedGitHubUserIdentity> {
  const requestedLogin = normalizeGitHubLogin(username);
  if (!requestedLogin) {
    throw new TypeError("GitHub username is invalid");
  }
  const token = githubApiToken();
  let payload: unknown;
  try {
    payload = await gitHubPublicApi.fetchGitHubJson(
      `${gitHubPublicApi.GITHUB_API_ORIGIN}/users/${encodeURIComponent(requestedLogin)}`,
      fetch,
      token,
    );
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

function cloudflareAccessAssertion(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
}): { assertion: string; principal: string } | undefined {
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
  const assertion = headerValue(
    params.requestHeaders?.[CLOUDFLARE_ACCESS_ASSERTION_HEADER],
  )?.trim();
  return principal && assertion ? { assertion, principal } : undefined;
}

export function createAuthenticatedGitHubIdentitySync(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
}): AuthenticatedGitHubIdentitySync | undefined {
  const tailscaleLogin = params.authResult.tailscaleIdentity
    ? classifyTailscaleLogin(params.authResult.tailscaleIdentity.login)
    : undefined;
  if (tailscaleLogin?.kind === "provider" && tailscaleLogin.provider === "github") {
    return createLazyPromise(async () => {
      const identity = await resolveGitHubUserIdentityByLogin(tailscaleLogin.subject);
      const profile = syncGitHubIdentity({
        identity,
        authenticationAlias: { kind: "github-login", login: tailscaleLogin.subject },
        initialDisplayName: params.authResult.tailscaleIdentity?.name,
      });
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    });
  }

  const access = cloudflareAccessAssertion(params);
  if (!access) {
    return undefined;
  }
  return createLazyPromise(async () => {
    const accessIdentity = await resolveCloudflareAccessIdentity(
      access.assertion,
      access.principal,
      params.authConfig?.trustedProxy?.cloudflareAccessOidc,
    );
    const accountId = accessIdentity.accountId;
    if (accountId === undefined) {
      const profile = ensureProfileForEmail(access.principal);
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    }
    const identityBinding = { accountId, email: access.principal };
    // Service auth raises public-data quota; Access still owns the signed-in account id.
    const token = githubApiToken();
    let lookup: GitHubIdentityLookup;
    try {
      lookup = await gitHubPublicApi.withOptionalGitHubAuth(token, (requestToken) =>
        resolveGitHubUserIdentityById(accountId, requestToken, fetch),
      );
    } catch (error) {
      if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.retryable) {
        // Retry failures may reuse only the exact verified email + immutable-account binding.
        const cached = resolveCachedGitHubIdentity(identityBinding);
        if (cached) {
          return cached;
        }
      }
      throw error instanceof gitHubPublicApi.ControlUiGitHubError
        ? error
        : new gitHubPublicApi.ControlUiGitHubError(502, "GitHub request failed");
    }
    if (!lookup.refreshed) {
      // Re-read the exact current binding: unchanged metadata must not write profiles
      // and broadcast roster changes on each authenticated HTTP request.
      const cached = resolveCachedGitHubIdentity(identityBinding);
      if (cached) {
        return cached;
      }
    }
    const profile = syncGitHubIdentity({
      identity: lookup.identity,
      authenticationAlias: { kind: "email", email: access.principal },
      initialDisplayName:
        accessIdentity.provider === "github" ? accessIdentity.initialDisplayName : undefined,
      preserveEmailProfile: accessIdentity.provider === "oidc",
    });
    return { profileId: profile.id, updatedAt: profile.updatedAt };
  });
}

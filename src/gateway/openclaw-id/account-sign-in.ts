// OpenClaw ID sign-in for the Control UI's account menu, for a public client.
// On this machine: an OpenID Connect authorization code flow with PKCE. The browser
// opens the authorization URL in a popup and hands the returned code back; the
// Gateway holds the verifier and redeems the code, because the issuer serves no CORS.
// Elsewhere (a Control UI the issuer cannot redirect to): the device authorization
// grant (RFC 8628). The Gateway gets a user code for the browser to show, then polls
// the token endpoint for the ID token.
// Either way the ID token goes back to the browser, which keeps the account; the
// Gateway keeps only display claims in its claw record through the trusted completion
// callback, which only the loopback flow supplies.
import { createHash, randomBytes } from "node:crypto";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawIdAccount } from "./claw-store.js";

/** A refusal with a stable code, mapped to an RPC error by the method handler. */
export type OpenClawIdSignInRefusal = { ok: false; code: string; detail: string };

type IssuerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
};

type PendingDeviceSignIn = {
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  deviceCode: string;
  /** The connection identity that started it; only that identity may poll it. */
  owner: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
};

/** The user code and where to enter it, for the browser to show while the Gateway polls. */
export type OpenClawIdDeviceSignIn = {
  state: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  interval: number;
};

type PendingSignIn = {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
  createdAt: number;
};

type IdTokenClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nonce?: unknown;
  email?: unknown;
  name?: unknown;
};

/** Where the Control UI receives the issuer's redirect (registered per client). */
const SIGN_IN_CALLBACK_PATH = "/openclaw-id/callback";

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 16;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// RFC 8628 section 3.2 defaults and the slow_down increment (section 3.5).
const DEFAULT_DEVICE_INTERVAL_S = 5;
const SLOW_DOWN_INCREMENT_MS = 5_000;

function refusal(code: string, detail: string): OpenClawIdSignInRefusal {
  return { ok: false, code, detail };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// Hostnames a Control UI on this machine is served from (RFC 8252 section 7.3).
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Accepts only a loopback Control UI callback URL: http(s), the fixed path, no
// query, fragment or credentials. The issuer must also have it registered.
function isCallbackUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      LOOPBACK_HOSTNAMES.has(url.hostname) &&
      url.pathname.endsWith(SIGN_IN_CALLBACK_PATH) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Decodes a JWT payload. The token arrives straight from the issuer's token
// endpoint over TLS, which OIDC Core 3.1.3.7 accepts in place of a signature check.
function decodeClaims(idToken: string): IdTokenClaims | null {
  const payload = idToken.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    // SAFETY: checked to be a non-null object; every claim is validated before use.
    return claims && typeof claims === "object" ? (claims as IdTokenClaims) : null;
  } catch {
    return null;
  }
}

type JsonResponse = { status: number; httpOk: boolean; body: unknown };

// Fetches and parses JSON; a network failure or unreadable body becomes a
// refusal with `code` instead of an exception.
async function fetchJson(
  fetchImpl: typeof fetch,
  url: string | URL,
  init: RequestInit,
  code: string,
): Promise<JsonResponse | OpenClawIdSignInRefusal> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    return refusal(code, `${new URL(url).host} is unreachable: ${String(error)}`);
  }
  try {
    const text = await response.text();
    return { status: response.status, httpOk: response.ok, body: text ? JSON.parse(text) : null };
  } catch {
    return refusal(
      code,
      `${new URL(url).host} returned an unreadable response (HTTP ${response.status})`,
    );
  }
}

function isRefusal(value: object): value is OpenClawIdSignInRefusal {
  return "ok" in value && value.ok === false;
}

// True when `endpoint` is an absolute URL on the same origin as `issuerUrl`.
function onIssuerOrigin(endpoint: unknown, issuerUrl: string): endpoint is string {
  try {
    return typeof endpoint === "string" && new URL(endpoint).origin === new URL(issuerUrl).origin;
  } catch {
    return false;
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// Checks the claims the browser relies on: issuer, audience, nonce, expiry and subject.
// A device grant carries no nonce (`null`): its token answers only the device code the
// Gateway itself holds, so there is no front channel to inject a token into.
function acceptedClaims(
  claims: IdTokenClaims | null,
  expected: { issuer: string; clientId: string; nonce: string | null; nowMs: number },
): claims is IdTokenClaims & { sub: string; exp: number } {
  if (!claims) {
    return false;
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return (
    typeof claims.iss === "string" &&
    trimSlash(claims.iss) === trimSlash(expected.issuer) &&
    audiences.includes(expected.clientId) &&
    claims.nonce === (expected.nonce ?? undefined) &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > expected.nowMs &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0
  );
}

function accountFrom(claims: IdTokenClaims & { sub: string; exp: number }): OpenClawIdAccount {
  return {
    sub: claims.sub,
    email: optionalText(claims.email),
    name: optionalText(claims.name),
    exp: claims.exp,
  };
}

function httpUrl(value: unknown): value is string {
  try {
    const url = new URL(String(value));
    return typeof value === "string" && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

/**
 * Creates the sign-in flow for one Gateway. `begin` returns the authorization
 * URL for the popup; `complete` redeems the returned code once; `enrollmentCode`
 * asks Discovery for a link code with the signed-in account's ID token.
 */
export function createOpenClawIdSignIn(
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, PendingSignIn>();
  const pendingDevices = new Map<string, PendingDeviceSignIn>();

  // Drops expired sign-ins, then the oldest ones past the cap (Map keeps insertion order).
  const prune = () => {
    for (const [state, entry] of pending) {
      if (now() - entry.createdAt > PENDING_TTL_MS || pending.size >= MAX_PENDING) {
        pending.delete(state);
      }
    }
    for (const [state, entry] of pendingDevices) {
      if (now() >= entry.expiresAt || pendingDevices.size >= MAX_PENDING) {
        pendingDevices.delete(state);
      }
    }
  };

  // Reads the issuer's discovery document and checks it names this issuer and
  // keeps its token endpoint on the issuer's origin.
  const metadata = async (issuerUrl: string): Promise<IssuerMetadata | OpenClawIdSignInRefusal> => {
    const response = await fetchJson(
      fetchImpl,
      `${trimSlash(issuerUrl)}/.well-known/openid-configuration`,
      { headers: { accept: "application/json" } },
      "issuer_unavailable",
    );
    if (isRefusal(response)) {
      return response;
    }
    if (!response.httpOk) {
      return refusal("issuer_unavailable", `issuer discovery failed with HTTP ${response.status}`);
    }
    const meta = asRecord(response.body);
    if (
      typeof meta.issuer !== "string" ||
      trimSlash(meta.issuer) !== trimSlash(issuerUrl) ||
      typeof meta.authorization_endpoint !== "string" ||
      !onIssuerOrigin(meta.token_endpoint, issuerUrl)
    ) {
      return refusal("issuer_invalid", "issuer metadata does not match the configured issuer");
    }
    return {
      issuer: meta.issuer,
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      ...(onIssuerOrigin(meta.device_authorization_endpoint, issuerUrl)
        ? { device_authorization_endpoint: meta.device_authorization_endpoint }
        : {}),
    };
  };

  return {
    /** Starts a sign-in and returns the issuer URL the browser opens in a popup. */
    async begin(params: {
      issuerUrl: string;
      clientId: string;
      redirectUri: unknown;
    }): Promise<{ authorizationUrl: string; state: string } | OpenClawIdSignInRefusal> {
      if (!isCallbackUrl(params.redirectUri)) {
        return refusal(
          "malformed",
          `redirectUri must be a loopback URL ending with ${SIGN_IN_CALLBACK_PATH}`,
        );
      }
      const meta = await metadata(params.issuerUrl);
      if (isRefusal(meta)) {
        return meta;
      }
      const verifier = base64url(randomBytes(32));
      const state = base64url(randomBytes(16));
      const nonce = base64url(randomBytes(16));
      prune();
      pending.set(state, {
        issuerUrl: params.issuerUrl,
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        verifier,
        nonce,
        createdAt: now(),
      });
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: base64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.href, state };
    },

    /** Redeems the code for a pending sign-in (once) and returns the account and ID token. */
    async complete(params: {
      state: unknown;
      code: unknown;
      /** Gateway-owned sink, called only after all issuer-token checks pass. */
      onVerifiedAccount?: (account: OpenClawIdAccount) => Promise<void>;
    }): Promise<{ account: OpenClawIdAccount; idToken: string } | OpenClawIdSignInRefusal> {
      const entry = typeof params.state === "string" ? pending.get(params.state) : undefined;
      if (typeof params.state === "string") {
        pending.delete(params.state);
      }
      if (
        !entry ||
        now() - entry.createdAt > PENDING_TTL_MS ||
        typeof params.code !== "string" ||
        !params.code
      ) {
        return refusal("state_mismatch", "sign-in expired or was already used; start again");
      }
      const meta = await metadata(entry.issuerUrl);
      if (isRefusal(meta)) {
        return meta;
      }
      const response = await fetchJson(
        fetchImpl,
        meta.token_endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: params.code,
            redirect_uri: entry.redirectUri,
            client_id: entry.clientId,
            code_verifier: entry.verifier,
          }),
        },
        "token_exchange_failed",
      );
      if (isRefusal(response)) {
        return response;
      }
      if (!response.httpOk) {
        return refusal(
          "token_exchange_failed",
          `token exchange failed with HTTP ${response.status}`,
        );
      }
      const tokens = asRecord(response.body);
      const idToken = typeof tokens.id_token === "string" ? tokens.id_token : "";
      const claims = decodeClaims(idToken);
      const expected = {
        issuer: meta.issuer,
        clientId: entry.clientId,
        nonce: entry.nonce,
        nowMs: now(),
      };
      if (!acceptedClaims(claims, expected)) {
        return refusal("id_token_invalid", "the issuer returned an unusable ID token");
      }
      const account = accountFrom(claims);
      await params.onVerifiedAccount?.(account);
      return { idToken, account };
    },

    /**
     * Starts a device sign-in for `owner` (the connection identity that may poll it) and
     * returns the user code and verification page the browser shows.
     */
    async beginDevice(params: {
      issuerUrl: string;
      clientId: string;
      owner: string;
    }): Promise<OpenClawIdDeviceSignIn | OpenClawIdSignInRefusal> {
      const meta = await metadata(params.issuerUrl);
      if (isRefusal(meta)) {
        return meta;
      }
      if (!meta.device_authorization_endpoint) {
        return refusal("device_unsupported", "the OpenClaw ID issuer offers no device sign-in");
      }
      const response = await fetchJson(
        fetchImpl,
        meta.device_authorization_endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({ client_id: params.clientId, scope: "openid profile email" }),
        },
        "issuer_unavailable",
      );
      if (isRefusal(response)) {
        return response;
      }
      if (!response.httpOk) {
        return refusal("issuer_unavailable", `device sign-in failed with HTTP ${response.status}`);
      }
      const body = asRecord(response.body);
      const complete = httpUrl(body.verification_uri_complete)
        ? body.verification_uri_complete
        : null;
      if (
        typeof body.device_code !== "string" ||
        !body.device_code ||
        typeof body.user_code !== "string" ||
        !body.user_code ||
        !httpUrl(body.verification_uri) ||
        typeof body.expires_in !== "number" ||
        !(body.expires_in > 0)
      ) {
        return refusal("issuer_invalid", "the issuer returned an unusable device code");
      }
      const interval =
        typeof body.interval === "number" && body.interval > 0
          ? body.interval
          : DEFAULT_DEVICE_INTERVAL_S;
      const state = base64url(randomBytes(16));
      // Never hold a code longer than a popup sign-in, whatever the issuer offers.
      const expiresAt = now() + Math.min(body.expires_in * 1000, PENDING_TTL_MS);
      prune();
      pendingDevices.set(state, {
        issuer: meta.issuer,
        tokenEndpoint: meta.token_endpoint,
        clientId: params.clientId,
        deviceCode: body.device_code,
        owner: params.owner,
        intervalMs: interval * 1000,
        nextPollAt: now() + interval * 1000,
        expiresAt,
      });
      return {
        state,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        verificationUriComplete: complete,
        expiresAt,
        interval,
      };
    },

    /**
     * Polls the token endpoint once for `owner`'s device sign-in. Returns `pending` until
     * the user approves, then the account and ID token (once). Never records the account.
     */
    async pollDevice(params: {
      state: unknown;
      owner: string;
    }): Promise<
      | { pending: true; interval: number }
      | { account: OpenClawIdAccount; idToken: string }
      | OpenClawIdSignInRefusal
    > {
      const state = typeof params.state === "string" ? params.state : "";
      const entry = pendingDevices.get(state);
      // Another identity's state is unknown to this caller; it must not cancel the owner's sign-in.
      if (!entry || entry.owner !== params.owner || now() >= entry.expiresAt) {
        if (entry?.owner === params.owner) {
          pendingDevices.delete(state);
        }
        return refusal("state_mismatch", "sign-in expired or was already used; start again");
      }
      if (now() < entry.nextPollAt) {
        return { pending: true, interval: Math.ceil(entry.intervalMs / 1000) };
      }
      entry.nextPollAt = now() + entry.intervalMs;
      const response = await fetchJson(
        fetchImpl,
        entry.tokenEndpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT,
            device_code: entry.deviceCode,
            client_id: entry.clientId,
          }),
        },
        "token_exchange_failed",
      );
      if (isRefusal(response)) {
        // A transient network failure keeps the sign-in; the next poll tries again.
        return { pending: true, interval: Math.ceil(entry.intervalMs / 1000) };
      }
      const body = asRecord(response.body);
      if (!response.httpOk) {
        if (body.error === "authorization_pending" || body.error === "slow_down") {
          if (body.error === "slow_down") {
            entry.intervalMs += SLOW_DOWN_INCREMENT_MS;
            entry.nextPollAt = now() + entry.intervalMs;
          }
          return { pending: true, interval: Math.ceil(entry.intervalMs / 1000) };
        }
        pendingDevices.delete(state);
        return body.error === "access_denied"
          ? refusal("access_denied", "the sign-in was cancelled in OpenClaw ID")
          : body.error === "expired_token"
            ? refusal("state_mismatch", "sign-in expired; start again")
            : refusal(
                "token_exchange_failed",
                `token exchange failed with HTTP ${response.status}`,
              );
      }
      pendingDevices.delete(state);
      const idToken = typeof body.id_token === "string" ? body.id_token : "";
      const claims = decodeClaims(idToken);
      const expected = {
        issuer: entry.issuer,
        clientId: entry.clientId,
        nonce: null,
        nowMs: now(),
      };
      if (!acceptedClaims(claims, expected)) {
        return refusal("id_token_invalid", "the issuer returned an unusable ID token");
      }
      return { idToken, account: accountFrom(claims) };
    },

    /** Asks Discovery for a one-time link code for the signed-in account. */
    async enrollmentCode(params: {
      discoveryUrl: string;
      idToken: unknown;
    }): Promise<{ code: string; expiresAt: number } | OpenClawIdSignInRefusal> {
      if (typeof params.idToken !== "string" || !params.idToken) {
        return refusal("malformed", "idToken is required");
      }
      const response = await fetchJson(
        fetchImpl,
        new URL("/v1/enrollment-codes", params.discoveryUrl),
        {
          method: "POST",
          headers: { authorization: `Bearer ${params.idToken}`, accept: "application/json" },
        },
        "unavailable",
      );
      if (isRefusal(response)) {
        return response;
      }
      if (response.status === 401) {
        return refusal("signed_out", "your OpenClaw ID sign-in expired; sign in again");
      }
      if (!response.httpOk) {
        return refusal("unavailable", `Discovery refused a link code (HTTP ${response.status})`);
      }
      const body = asRecord(response.body);
      if (typeof body.code !== "string" || typeof body.expires_at !== "number") {
        return refusal("unavailable", "Discovery returned no link code");
      }
      return { code: body.code, expiresAt: body.expires_at };
    },
  };
}

export type OpenClawIdSignIn = ReturnType<typeof createOpenClawIdSignIn>;

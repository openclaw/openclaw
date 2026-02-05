/**
 * OAuth flow handler for connection providers.
 *
 * Handles the complete OAuth2 authorization code flow with PKCE support.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type {
  ConnectionProvider,
  OAuthFlowState,
  OAuthFlowStartResult,
  OAuthFlowCompleteResult,
  ConnectionUserInfo,
} from "./types.js";
import { storeConnectionCredential } from "./credentials.js";
import { getConnectionProvider, buildScopeString, expandScopes } from "./registry.js";

const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 3 * 60 * 1000;

/** Generate PKCE code verifier and challenge */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Generate random state parameter */
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

/** Build the authorization URL for a provider */
export function buildAuthorizeUrl(params: {
  provider: ConnectionProvider;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge?: string;
}): string {
  const { provider, clientId, redirectUri, scopes, state, codeChallenge } = params;
  const scopeString = buildScopeString(provider.id, scopes);

  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  // Add scope if we have any
  if (scopeString) {
    query.set("scope", scopeString);
  }

  // Add PKCE if required
  if (codeChallenge && provider.oauth.pkceRequired) {
    query.set("code_challenge", codeChallenge);
    query.set("code_challenge_method", "S256");
  }

  // Add any provider-specific authorize params
  if (provider.oauth.authorizeParams) {
    for (const [key, value] of Object.entries(provider.oauth.authorizeParams)) {
      query.set(key, value);
    }
  }

  return `${provider.oauth.authorizeUrl}?${query.toString()}`;
}

/** Start an OAuth flow */
export function startOAuthFlow(params: {
  providerId: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  agentDir?: string;
}): OAuthFlowStartResult | { error: string } {
  const { providerId, clientId, redirectUri, scopes, agentDir } = params;

  const provider = getConnectionProvider(providerId);
  if (!provider) {
    return { error: `Unknown connection provider: ${providerId}` };
  }

  const state = generateState();
  const pkce = provider.oauth.pkceRequired ? generatePkce() : undefined;

  // Use provided scopes or defaults
  const requestedScopes = scopes ?? getDefaultScopesForProvider(provider);
  const expandedScopes = expandScopes(providerId, requestedScopes);

  const authorizeUrl = buildAuthorizeUrl({
    provider,
    clientId,
    redirectUri,
    scopes: expandedScopes,
    state,
    codeChallenge: pkce?.challenge,
  });

  const flowState: OAuthFlowState = {
    state,
    codeVerifier: pkce?.verifier,
    providerId,
    requestedScopes: expandedScopes,
    redirectUri,
    createdAt: Date.now(),
    agentDir,
  };

  return { authorizeUrl, flowState };
}

/** Get default scopes (required + recommended) for a provider */
function getDefaultScopesForProvider(provider: ConnectionProvider): string[] {
  return provider.oauth.scopes
    .filter((scope) => scope.required || scope.recommended)
    .map((scope) => scope.id);
}

/** Exchange authorization code for tokens */
export async function exchangeCodeForTokens(params: {
  providerId: string;
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<
  | {
      access: string;
      refresh?: string;
      expires?: number;
      scope?: string;
      rawResponse?: Record<string, unknown>;
    }
  | { error: string }
> {
  const { providerId, code, clientId, clientSecret, redirectUri, codeVerifier } = params;
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now();

  const provider = getConnectionProvider(providerId);
  if (!provider) {
    return { error: `Unknown connection provider: ${providerId}` };
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  if (codeVerifier && provider.oauth.pkceRequired) {
    body.set("code_verifier", codeVerifier);
  }

  try {
    const response = await fetchFn(provider.oauth.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    // Some providers (like GitHub) may return text/html or other content types
    const contentType = response.headers.get("content-type") ?? "";

    let data: Record<string, unknown>;

    if (contentType.includes("application/json")) {
      data = (await response.json()) as Record<string, unknown>;
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("text/plain")
    ) {
      // GitHub returns application/x-www-form-urlencoded
      const text = await response.text();
      data = Object.fromEntries(new URLSearchParams(text));
    } else {
      data = (await response.json()) as Record<string, unknown>;
    }

    // Check for errors in the response
    if (data.error) {
      const errorDesc = data.error_description ?? data.error;
      return { error: `Token exchange failed: ${errorDesc}` };
    }

    if (!response.ok) {
      return { error: `Token exchange failed: ${response.statusText}` };
    }

    const accessToken = String(data.access_token ?? "").trim();
    if (!accessToken) {
      return { error: "Token exchange returned no access_token" };
    }

    const refreshToken = data.refresh_token ? String(data.refresh_token).trim() : undefined;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
    const scope = data.scope ? String(data.scope) : undefined;

    const expires = expiresIn ? now + expiresIn * 1000 - DEFAULT_EXPIRES_BUFFER_MS : undefined;

    return {
      access: accessToken,
      refresh: refreshToken,
      expires,
      scope,
      rawResponse: data,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Token exchange failed: ${message}` };
  }
}

/** Complete an OAuth flow by exchanging the code and storing credentials */
export async function completeOAuthFlow(params: {
  flowState: OAuthFlowState;
  code: string;
  receivedState: string;
  clientId: string;
  clientSecret?: string;
  fetchFn?: typeof fetch;
}): Promise<OAuthFlowCompleteResult> {
  const { flowState, code, receivedState, clientId, clientSecret, fetchFn } = params;

  // Validate state
  if (receivedState !== flowState.state) {
    return { success: false, error: "Invalid OAuth state (possible CSRF)" };
  }

  // Check for timeout (5 minutes)
  const flowAge = Date.now() - flowState.createdAt;
  if (flowAge > 5 * 60 * 1000) {
    return { success: false, error: "OAuth flow expired" };
  }

  const provider = getConnectionProvider(flowState.providerId);
  if (!provider) {
    return { success: false, error: `Unknown provider: ${flowState.providerId}` };
  }

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens({
    providerId: flowState.providerId,
    code,
    clientId,
    clientSecret,
    redirectUri: flowState.redirectUri,
    codeVerifier: flowState.codeVerifier,
    fetchFn,
  });

  if ("error" in tokens) {
    return { success: false, error: tokens.error };
  }

  // Fetch user info if the provider supports it
  let userInfo: ConnectionUserInfo | undefined;
  if (provider.fetchUserInfo) {
    try {
      const info = await provider.fetchUserInfo(tokens.access);
      if (info) {
        userInfo = info;
      }
    } catch {
      // User info fetch is optional, continue without it
    }
  }

  // Determine granted scopes
  // Some providers return the granted scope in the token response
  const grantedScopes = tokens.scope
    ? tokens.scope.split(provider.oauth.scopeSeparator ?? " ").filter(Boolean)
    : flowState.requestedScopes;

  // Store the credential
  const profileId = storeConnectionCredential({
    providerId: flowState.providerId,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    email: userInfo?.email ?? userInfo?.username,
    grantedScopes,
    userInfo,
    agentDir: flowState.agentDir,
  });

  return {
    success: true,
    profileId,
    userInfo,
    grantedScopes,
  };
}

/** Parse OAuth callback input (URL or code) */
export function parseOAuthCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (error) {
      return { error: errorDescription ?? error };
    }

    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: "Missing 'state' parameter. Paste the full URL." };
    }

    return { code, state };
  } catch {
    // Not a URL, treat as raw code
    if (!expectedState) {
      return { error: "Paste the full redirect URL, not just the code." };
    }
    return { code: trimmed, state: expectedState };
  }
}

/** Wait for OAuth callback on local server */
export async function waitForLocalCallback(params: {
  redirectUri: string;
  expectedState: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}): Promise<{ code: string; state: string } | { error: string }> {
  const { redirectUri, expectedState, onProgress } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  const redirectUrl = new URL(redirectUri);
  if (redirectUrl.protocol !== "http:") {
    return { error: `Redirect URI must be http:// for local callback (got ${redirectUri})` };
  }

  const hostname = redirectUrl.hostname || "127.0.0.1";
  const port = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 80;
  const expectedPath = redirectUrl.pathname || "/";

  return await new Promise((resolve) => {
    let timeout: NodeJS.Timeout | null = null;

    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);

        if (requestUrl.pathname !== expectedPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();
        const error = requestUrl.searchParams.get("error");
        const errorDescription = requestUrl.searchParams.get("error_description");

        if (error) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(buildCallbackHtml("Error", errorDescription ?? error));
          if (timeout) {
            clearTimeout(timeout);
          }
          server.close();
          resolve({ error: errorDescription ?? error });
          return;
        }

        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Missing code");
          return;
        }

        if (!state || state !== expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid state");
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(buildCallbackHtml("Success", "Authorization complete. You can close this window."));

        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        resolve({ code, state });
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        resolve({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.once("error", (err) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      server.close();
      resolve({ error: err.message });
    });

    server.listen(port, hostname, () => {
      onProgress?.(`Waiting for OAuth callback on ${redirectUrl.origin}${expectedPath}...`);
    });

    timeout = setTimeout(() => {
      try {
        server.close();
      } catch {
        // Ignore close errors
      }
      resolve({ error: "OAuth callback timeout" });
    }, timeoutMs);
  });
}

/** Build HTML for callback response */
function buildCallbackHtml(title: string, message: string): string {
  const isSuccess = title.toLowerCase() === "success";
  const color = isSuccess ? "#22c55e" : "#ef4444";
  const icon = isSuccess ? "✓" : "✗";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Clawdbrain OAuth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f9fafb;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 400px;
    }
    .icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: ${color};
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 1rem;
    }
    h1 {
      color: #111827;
      margin: 0 0 0.5rem;
    }
    p {
      color: #6b7280;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

/** Get client credentials from environment or throw */
export function getClientCredentials(providerId: string): {
  clientId: string;
  clientSecret?: string;
} {
  const provider = getConnectionProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown connection provider: ${providerId}`);
  }

  const clientIdEnv = provider.oauth.clientIdEnvVar;
  const clientSecretEnv = provider.oauth.clientSecretEnvVar;

  const clientId = clientIdEnv ? process.env[clientIdEnv]?.trim() : undefined;
  const clientSecret = clientSecretEnv ? process.env[clientSecretEnv]?.trim() : undefined;

  if (!clientId) {
    throw new Error(
      `Missing ${clientIdEnv} environment variable for ${provider.label} OAuth. ` +
        `Register an OAuth app and set ${clientIdEnv}.`,
    );
  }

  return { clientId, clientSecret };
}

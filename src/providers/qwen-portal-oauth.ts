import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { formatCliCommand } from "../cli/command-format.js";

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";

export async function refreshQwenPortalCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
  }

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: QWEN_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400) {
      throw new Error(
        `Qwen OAuth refresh token expired or invalid. Re-authenticate with \`${formatCliCommand("openclaw models auth login --provider qwen-portal")}\`.`,
      );
    }
    throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Qwen OAuth refresh response missing access token.");
  }

  // RFC 6749 §10.4: servers SHOULD rotate refresh tokens on each use to prevent
  // indefinite reuse of a stolen token. If the server omits a new refresh_token,
  // retain the existing one but log a warning — do NOT silently swallow the
  // absence, as that would mask a misconfigured or compromised token endpoint.
  // See also: GHSA-7w99-47vx-hm6q
  if (!payload.refresh_token) {
    console.warn(
      "[security] Qwen OAuth: server did not rotate refresh token (RFC 6749 §10.4). " +
        "Retaining existing refresh token. If this persists, re-authenticate.",
    );
  }

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

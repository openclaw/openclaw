import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { formatCliCommand } from "../cli/command-format.js";

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";

export async function refreshQwenPortalCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const refreshToken = credentials.refresh?.trim();
  if (!refreshToken) {
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
      refresh_token: refreshToken,
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
  const accessToken = payload.access_token?.trim();
  const newRefreshToken = payload.refresh_token?.trim();
  const expiresIn = payload.expires_in;

  if (!accessToken) {
    throw new Error("Qwen OAuth refresh response missing access token.");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Qwen OAuth refresh response missing or invalid expires_in.");
  }

  return {
    ...credentials,
    access: accessToken,
    // RFC 6749 section 6: new refresh token is optional; if present, replace old.
    refresh: newRefreshToken || refreshToken,
    expires: Date.now() + expiresIn * 1000,
  };
}

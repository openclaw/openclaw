import { pemToBase64Spki } from "./keys.js";
import { validateOwnerUrl } from "./owner-url.js";

const DEFAULT_API_URL = "https://api.openbotauth.org";
const REGISTER_TIMEOUT_MS = 10_000;

export type RegisterKeyResult = {
  ok: boolean;
  ownerUrl?: string;
  username?: string;
  error?: string;
};

/**
 * Register (or rotate) a public key with the OpenBotAuth registry.
 *
 * Uses the per-user key flow:
 *   1. GET /auth/session → username
 *   2. POST /keys → upload base64 SPKI public key
 *   3. Owner URL = {apiUrl}/jwks/{username}.json
 */
export async function registerKey(params: {
  publicKeyPem: string;
  isUpdate?: boolean;
  token: string;
  apiUrl?: string;
}): Promise<RegisterKeyResult> {
  const apiUrl = (params.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");

  // Get username first to build the owner URL.
  const session = await fetchSession(apiUrl, params.token);
  if (!session.ok) {
    return { ok: false, error: session.error };
  }

  // Convert PEM to base64-encoded SPKI DER (what OBA expects).
  const publicKeyBase64 = pemToBase64Spki(params.publicKeyPem);

  // Upload key.
  const result = await postKey(apiUrl, params.token, publicKeyBase64, params.isUpdate);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const ownerUrl = `${apiUrl}/jwks/${session.username}.json`;
  const urlCheck = validateOwnerUrl(ownerUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: `constructed owner URL is invalid: ${urlCheck.error}` };
  }

  return { ok: true, ownerUrl, username: session.username };
}

// --- internal helpers ---

type SessionResult = { ok: true; username: string } | { ok: false; error: string };

async function fetchSession(apiUrl: string, token: string): Promise<SessionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);

  try {
    const res = await fetch(`${apiUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `authentication failed: HTTP ${res.status}: ${text}` };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `session fetch failed: HTTP ${res.status}: ${text}` };
    }

    const data = (await res.json()) as { profile?: { username?: unknown } };
    const username = data.profile?.username;
    if (!username || typeof username !== "string") {
      return { ok: false, error: "profile has no username — complete OBA profile setup first" };
    }
    // Reject path traversal / URL metacharacters in username before using it in URL construction.
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return { ok: false, error: "invalid username format from server" };
    }

    return { ok: true, username };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `session fetch failed: ${detail}` };
  } finally {
    clearTimeout(timeout);
  }
}

type PostKeyResult = { ok: boolean; error?: string };

async function postKey(
  apiUrl: string,
  token: string,
  publicKeyBase64: string,
  isUpdate?: boolean,
): Promise<PostKeyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);

  try {
    const res = await fetch(`${apiUrl}/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        public_key: publicKeyBase64,
        is_update: isUpdate ?? false,
      }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `authentication failed: HTTP ${res.status}: ${text}` };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `key registration failed: HTTP ${res.status}: ${text}` };
    }

    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `key registration failed: ${detail}` };
  } finally {
    clearTimeout(timeout);
  }
}

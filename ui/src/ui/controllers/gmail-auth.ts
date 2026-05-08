import type { GatewayBrowserClient } from "../gateway.ts";

const GMAIL_OAUTH_STORAGE_KEY = "openclaw:gmail-oauth:pending";

export type GmailAuthProfile = {
  profileId: string;
  email?: string;
  displayName?: string;
  expires?: number;
};

export type GmailAuthStatusResult = {
  providerId: string;
  connected: boolean;
  profiles: GmailAuthProfile[];
};

export type GmailAuthState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  gmailAuthLoading: boolean;
  gmailAuthConnectPending: boolean;
  gmailAuthStatus: GmailAuthStatusResult | null;
  gmailAuthError: string | null;
};

type PendingGmailOAuth = {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toBase64Url(new Uint8Array(digest));
}

function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function buildRedirectUri(): string {
  const url = new URL(window.location.href);
  for (const key of ["code", "state", "scope", "error", "error_subtype", "authuser", "prompt"]) {
    url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

function readPendingGmailOAuth(): PendingGmailOAuth | null {
  try {
    const raw = sessionStorage.getItem(GMAIL_OAUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PendingGmailOAuth>;
    if (
      typeof parsed?.state !== "string" ||
      typeof parsed?.verifier !== "string" ||
      typeof parsed?.redirectUri !== "string"
    ) {
      return null;
    }
    return {
      state: parsed.state,
      verifier: parsed.verifier,
      redirectUri: parsed.redirectUri,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writePendingGmailOAuth(value: PendingGmailOAuth | null) {
  if (!value) {
    sessionStorage.removeItem(GMAIL_OAUTH_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(GMAIL_OAUTH_STORAGE_KEY, JSON.stringify(value));
}

function clearGmailOAuthParamsFromUrl() {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["code", "state", "scope", "error", "error_subtype", "authuser", "prompt"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState({}, "", url.toString());
  }
}

function readRedirectParams() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code")?.trim() || "";
  const state = url.searchParams.get("state")?.trim() || "";
  const error = url.searchParams.get("error")?.trim() || "";
  return {
    code: code || null,
    state: state || null,
    error: error || null,
  };
}

export async function loadGmailAuthStatus(state: GmailAuthState): Promise<void> {
  if (!state.client || !state.connected || state.gmailAuthLoading) {
    return;
  }
  state.gmailAuthLoading = true;
  state.gmailAuthError = null;
  try {
    state.gmailAuthStatus = await state.client.request<GmailAuthStatusResult>(
      "gmail.auth.status",
      {},
    );
  } catch (error) {
    state.gmailAuthError = error instanceof Error ? error.message : String(error);
    state.gmailAuthStatus = null;
  } finally {
    state.gmailAuthLoading = false;
  }
}

export async function startGmailOAuthConnect(state: GmailAuthState): Promise<void> {
  if (!state.client || !state.connected || state.gmailAuthConnectPending) {
    return;
  }
  state.gmailAuthConnectPending = true;
  state.gmailAuthError = null;
  try {
    const verifier = randomBase64Url(32);
    const challenge = await sha256Base64Url(verifier);
    const oauthState = randomBase64Url(24);
    const redirectUri = buildRedirectUri();
    writePendingGmailOAuth({
      state: oauthState,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    });
    const result = await state.client.request<{ url: string }>("gmail.auth.url", {
      challenge,
      state: oauthState,
      redirectUri,
    });
    if (!result?.url) {
      throw new Error("Gmail auth URL was not returned.");
    }
    window.location.assign(result.url);
  } catch (error) {
    writePendingGmailOAuth(null);
    state.gmailAuthConnectPending = false;
    state.gmailAuthError = error instanceof Error ? error.message : String(error);
  }
}

export async function maybeCompleteGmailOAuthRedirect(state: GmailAuthState): Promise<boolean> {
  if (!state.client || !state.connected || state.gmailAuthConnectPending) {
    return false;
  }
  const redirect = readRedirectParams();
  if (!redirect.code && !redirect.error) {
    return false;
  }

  state.gmailAuthConnectPending = true;
  state.gmailAuthError = null;
  try {
    if (redirect.error) {
      throw new Error(`Gmail OAuth failed: ${redirect.error}`);
    }
    const pending = readPendingGmailOAuth();
    if (!pending) {
      throw new Error("Missing pending Gmail OAuth session.");
    }
    if (!redirect.state || redirect.state !== pending.state) {
      throw new Error("Gmail OAuth state mismatch.");
    }
    await state.client.request("gmail.auth.exchange", {
      code: redirect.code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
    writePendingGmailOAuth(null);
    clearGmailOAuthParamsFromUrl();
    await loadGmailAuthStatus(state);
    return true;
  } catch (error) {
    writePendingGmailOAuth(null);
    clearGmailOAuthParamsFromUrl();
    state.gmailAuthError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    state.gmailAuthConnectPending = false;
  }
}

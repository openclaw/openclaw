import type { OpenClawApp } from "../app.ts";
import type { MctlConnectStatus } from "../types.ts";

const MCTL_CALLBACK_MARKER = "mctl_oauth";

type MctlConnectState = {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> } | null;
  connected: boolean;
  basePath: string;
  mctlConnectLoading: boolean;
  mctlConnectStatus: MctlConnectStatus | null;
  mctlConnectError: string | null;
  mctlCallbackCode: string | null;
  mctlCallbackState: string | null;
  mctlCallbackError: string | null;
};

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildRedirectUri(basePath: string): string {
  const resolvedBasePath = normalizeBasePath(basePath);
  const url = new URL(`${resolvedBasePath}/overview`, window.location.origin);
  url.searchParams.set(MCTL_CALLBACK_MARKER, "1");
  return url.toString();
}

export async function requestMctlConnectAuthorizeUrl(params: {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> };
  basePath: string;
}): Promise<string> {
  const res = await params.client.request<{ authorizeUrl?: string }>("mctl.connect.start", {
    redirectUri: buildRedirectUri(params.basePath),
  });
  const authorizeUrl = typeof res.authorizeUrl === "string" ? res.authorizeUrl.trim() : "";
  if (!authorizeUrl) {
    throw new Error("missing authorizeUrl");
  }
  return authorizeUrl;
}

export function captureMctlConnectCallbackFromUrl(state: MctlConnectState) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get(MCTL_CALLBACK_MARKER) !== "1") {
    return;
  }
  state.mctlCallbackCode = url.searchParams.get("code")?.trim() || null;
  state.mctlCallbackState = url.searchParams.get("state")?.trim() || null;
  const error = url.searchParams.get("error")?.trim() || null;
  const errorDescription = url.searchParams.get("error_description")?.trim() || null;
  state.mctlCallbackError = errorDescription ?? error;
  url.searchParams.delete(MCTL_CALLBACK_MARKER);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState({}, "", url.toString());
}

export async function loadMctlConnectStatus(state: MctlConnectState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    state.mctlConnectStatus = await state.client.request<MctlConnectStatus>(
      "mctl.connect.status",
      {},
    );
    state.mctlConnectError = null;
  } catch (err) {
    state.mctlConnectError = String(err);
  }
}

export async function startMctlConnect(state: MctlConnectState) {
  if (!state.client || !state.connected || state.mctlConnectLoading) {
    return;
  }
  state.mctlConnectLoading = true;
  state.mctlConnectError = null;
  try {
    const authorizeUrl = await requestMctlConnectAuthorizeUrl({
      client: state.client,
      basePath: state.basePath,
    });
    window.location.assign(authorizeUrl);
  } catch (err) {
    state.mctlConnectError = String(err);
    state.mctlConnectLoading = false;
  }
}

export async function disconnectMctl(state: MctlConnectState) {
  if (!state.client || !state.connected || state.mctlConnectLoading) {
    return;
  }
  state.mctlConnectLoading = true;
  try {
    state.mctlConnectStatus = await state.client.request<MctlConnectStatus>(
      "mctl.connect.disconnect",
      {},
    );
    state.mctlConnectError = null;
  } catch (err) {
    state.mctlConnectError = String(err);
  } finally {
    state.mctlConnectLoading = false;
  }
}

export async function maybeCompleteMctlConnect(state: MctlConnectState) {
  if (!state.client || !state.connected || state.mctlConnectLoading) {
    return;
  }
  if (state.mctlCallbackError) {
    state.mctlConnectError = state.mctlCallbackError;
    state.mctlCallbackError = null;
    await loadMctlConnectStatus(state);
    return;
  }
  if (!state.mctlCallbackCode || !state.mctlCallbackState) {
    return;
  }
  state.mctlConnectLoading = true;
  try {
    state.mctlConnectStatus = await state.client.request<MctlConnectStatus>(
      "mctl.connect.complete",
      {
        code: state.mctlCallbackCode,
        state: state.mctlCallbackState,
      },
    );
    state.mctlConnectError = null;
  } catch (err) {
    state.mctlConnectError = String(err);
  } finally {
    state.mctlCallbackCode = null;
    state.mctlCallbackState = null;
    state.mctlCallbackError = null;
    state.mctlConnectLoading = false;
  }
}

export type { OpenClawApp };

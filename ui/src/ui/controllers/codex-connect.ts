import type { OpenClawApp } from "../app.ts";
import type { OpenAICodexConnectStatus } from "../types.ts";

const CODEX_CALLBACK_MARKER = "codex_oauth";

type CodexConnectState = {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> } | null;
  connected: boolean;
  basePath: string;
  codexConnectLoading: boolean;
  codexConnectStatus: OpenAICodexConnectStatus | null;
  codexConnectError: string | null;
  codexCallbackCode: string | null;
  codexCallbackState: string | null;
  codexCallbackError: string | null;
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
  url.searchParams.set(CODEX_CALLBACK_MARKER, "1");
  return url.toString();
}

export async function requestCodexConnectAuthorizeUrl(params: {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> };
  basePath: string;
}): Promise<string> {
  const res = await params.client.request<{ authorizeUrl?: string }>("codex.connect.start", {
    redirectUri: buildRedirectUri(params.basePath),
  });
  const authorizeUrl = typeof res.authorizeUrl === "string" ? res.authorizeUrl.trim() : "";
  if (!authorizeUrl) {
    throw new Error("missing authorizeUrl");
  }
  return authorizeUrl;
}

export function captureCodexConnectCallbackFromUrl(state: CodexConnectState) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get(CODEX_CALLBACK_MARKER) !== "1") {
    return;
  }
  state.codexCallbackCode = url.searchParams.get("code")?.trim() || null;
  state.codexCallbackState = url.searchParams.get("state")?.trim() || null;
  const error = url.searchParams.get("error")?.trim() || null;
  const errorDescription = url.searchParams.get("error_description")?.trim() || null;
  state.codexCallbackError = errorDescription ?? error;
  url.searchParams.delete(CODEX_CALLBACK_MARKER);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState({}, "", url.toString());
}

export async function loadCodexConnectStatus(state: CodexConnectState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    state.codexConnectStatus = await state.client.request<OpenAICodexConnectStatus>(
      "codex.connect.status",
      {},
    );
    state.codexConnectError = null;
  } catch (err) {
    state.codexConnectError = String(err);
  }
}

export async function startCodexConnect(state: CodexConnectState) {
  if (!state.client || !state.connected || state.codexConnectLoading) {
    return;
  }
  state.codexConnectLoading = true;
  state.codexConnectError = null;
  try {
    const authorizeUrl = await requestCodexConnectAuthorizeUrl({
      client: state.client,
      basePath: state.basePath,
    });
    window.location.assign(authorizeUrl);
  } catch (err) {
    state.codexConnectError = String(err);
    state.codexConnectLoading = false;
  }
}

export async function disconnectCodex(state: CodexConnectState) {
  if (!state.client || !state.connected || state.codexConnectLoading) {
    return;
  }
  state.codexConnectLoading = true;
  try {
    state.codexConnectStatus = await state.client.request<OpenAICodexConnectStatus>(
      "codex.connect.disconnect",
      {},
    );
    state.codexConnectError = null;
  } catch (err) {
    state.codexConnectError = String(err);
  } finally {
    state.codexConnectLoading = false;
  }
}

export async function maybeCompleteCodexConnect(state: CodexConnectState) {
  if (!state.client || !state.connected || state.codexConnectLoading) {
    return;
  }
  if (state.codexCallbackError) {
    state.codexConnectError = state.codexCallbackError;
    state.codexCallbackError = null;
    await loadCodexConnectStatus(state);
    return;
  }
  if (!state.codexCallbackCode || !state.codexCallbackState) {
    return;
  }
  state.codexConnectLoading = true;
  try {
    state.codexConnectStatus = await state.client.request<OpenAICodexConnectStatus>(
      "codex.connect.complete",
      {
        code: state.codexCallbackCode,
        state: state.codexCallbackState,
      },
    );
    state.codexConnectError = null;
  } catch (err) {
    state.codexConnectError = String(err);
    await loadCodexConnectStatus(state);
  } finally {
    state.codexCallbackCode = null;
    state.codexCallbackState = null;
    state.codexCallbackError = null;
    state.codexConnectLoading = false;
  }
}

export type { OpenClawApp };

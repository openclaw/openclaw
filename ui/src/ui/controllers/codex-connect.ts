import type { OpenClawApp } from "../app.ts";
import type { OpenAICodexConnectStatus } from "../types.ts";

type CodexConnectState = {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> } | null;
  connected: boolean;
  basePath: string;
  codexConnectLoading: boolean;
  codexConnectStatus: OpenAICodexConnectStatus | null;
  codexConnectError: string | null;
  codexManualInput: string;
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

function buildOverviewUrl(basePath: string): string {
  const resolvedBasePath = normalizeBasePath(basePath);
  return new URL(`${resolvedBasePath}/overview`, window.location.origin).toString();
}

export async function requestCodexConnectAuthorizeUrl(params: {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> };
  basePath: string;
}): Promise<string> {
  const res = await params.client.request<{ authorizeUrl?: string }>("codex.connect.start", {
    redirectUri: buildOverviewUrl(params.basePath),
  });
  const authorizeUrl = typeof res.authorizeUrl === "string" ? res.authorizeUrl.trim() : "";
  if (!authorizeUrl) {
    throw new Error("missing authorizeUrl");
  }
  return authorizeUrl;
}

export function captureCodexConnectCallbackFromUrl(state: CodexConnectState) {
  void state;
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
    const popup = window.open(authorizeUrl, "_blank", "noopener,noreferrer");
    if (!popup) {
      window.location.assign(authorizeUrl);
      return;
    }
    state.codexConnectError =
      "OpenAI sign-in opened in a new tab. After it redirects to localhost, paste the full redirect URL or code below.";
  } catch (err) {
    state.codexConnectError = String(err);
    state.codexConnectLoading = false;
  }
}

export function updateCodexManualInput(state: CodexConnectState, value: string) {
  state.codexManualInput = value;
}

export async function submitCodexManualInput(state: CodexConnectState) {
  if (!state.client || !state.connected || state.codexConnectLoading) {
    return;
  }
  const input = state.codexManualInput.trim();
  if (!input) {
    state.codexConnectError = "Paste the full localhost redirect URL or the authorization code.";
    return;
  }
  state.codexConnectLoading = true;
  try {
    state.codexConnectStatus = await state.client.request<OpenAICodexConnectStatus>(
      "codex.connect.complete",
      { input },
    );
    state.codexConnectError = null;
    state.codexManualInput = "";
  } catch (err) {
    state.codexConnectError = String(err);
    await loadCodexConnectStatus(state);
  } finally {
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

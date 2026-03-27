import { getPluginRuntimeRequestAttributionScope } from "./request-attribution-scope.js";

type PluginRuntimeRequestAttributionFetchState = {
  installed: boolean;
  originalFetch?: typeof globalThis.fetch;
};

const PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_FETCH_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeRequestAttributionFetchState",
);

const pluginRuntimeRequestAttributionFetchState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_FETCH_STATE_KEY]?: PluginRuntimeRequestAttributionFetchState;
  };
  const existing = globalState[PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_FETCH_STATE_KEY];
  if (existing) {
    return existing;
  }
  const created: PluginRuntimeRequestAttributionFetchState = { installed: false };
  globalState[PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_FETCH_STATE_KEY] = created;
  return created;
})();

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function resolveVidaOpenAiBaseUrl(): string | undefined {
  const vidaApiBaseUrl = normalizeBaseUrl(process.env.VIDA_API_BASE_URL);
  if (!vidaApiBaseUrl) {
    return undefined;
  }
  return new URL("openai/v1", `${vidaApiBaseUrl}/`).toString().replace(/\/$/, "");
}

function resolveRequestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input && typeof input === "object" && "url" in input) {
    const url = input.url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}

function isVidaOpenAiRequest(url: string | undefined, targetBaseUrl: string | undefined): boolean {
  if (!url || !targetBaseUrl) {
    return false;
  }
  return url === targetBaseUrl || url.startsWith(`${targetBaseUrl}/`);
}

export function installPluginRuntimeRequestAttributionFetch(): void {
  if (
    pluginRuntimeRequestAttributionFetchState.installed ||
    typeof globalThis.fetch !== "function"
  ) {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  pluginRuntimeRequestAttributionFetchState.originalFetch = originalFetch;

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const targetBaseUrl = resolveVidaOpenAiBaseUrl();
    const requestUrl = resolveRequestUrl(input);
    if (!isVidaOpenAiRequest(requestUrl, targetBaseUrl)) {
      return originalFetch(input, init);
    }

    const scope = getPluginRuntimeRequestAttributionScope();
    if (!scope?.agentId && !scope?.sessionKey) {
      return originalFetch(input, init);
    }

    const headers = new Headers(
      init?.headers ??
        (input && typeof input === "object" && "headers" in input ? input.headers : undefined),
    );
    if (scope.agentId && !headers.has("x-openclaw-agent-id")) {
      headers.set("x-openclaw-agent-id", scope.agentId);
    }
    if (scope.sessionKey && !headers.has("x-openclaw-session-key")) {
      headers.set("x-openclaw-session-key", scope.sessionKey);
    }

    return originalFetch(input, { ...init, headers });
  }) as typeof globalThis.fetch;

  pluginRuntimeRequestAttributionFetchState.installed = true;
}

export function resetPluginRuntimeRequestAttributionFetchForTests(): void {
  if (pluginRuntimeRequestAttributionFetchState.originalFetch) {
    globalThis.fetch = pluginRuntimeRequestAttributionFetchState.originalFetch;
  }
  pluginRuntimeRequestAttributionFetchState.installed = false;
  pluginRuntimeRequestAttributionFetchState.originalFetch = undefined;
}

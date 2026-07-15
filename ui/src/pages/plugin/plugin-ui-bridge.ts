import { generateUUID } from "../../lib/uuid.ts";

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "set-cookie",
  "x-openclaw-scopes",
]);
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

type PluginUiRequestMessage = {
  v?: unknown;
  type?: unknown;
  id?: unknown;
  path?: unknown;
  init?: unknown;
};

type PluginUiBridgeTarget = {
  frame: HTMLIFrameElement;
  key: string;
  onReload?: () => void;
  pluginId: string;
  src: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePath(pathname: string): string {
  let resolved = pathname;
  try {
    resolved = new URL(pathname, window.location.origin).pathname;
  } catch {
    // Keep invalid input for the containment checks below to reject.
  }
  const collapsed = resolved
    .trim()
    .toLowerCase()
    .replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed || "/";
}

function isPluginOwnedPath(pluginId: string, pathname: string): boolean {
  const pluginRoot = normalizePath(`/plugins/${pluginId.trim()}`);
  const candidates = new Set([normalizePath(pathname)]);
  let decoded = pathname;
  try {
    for (let pass = 0; pass < 32; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return [...candidates].every(
          (candidate) => candidate === pluginRoot || candidate.startsWith(`${pluginRoot}/`),
        );
      }
      decoded = next;
      candidates.add(normalizePath(decoded));
    }
  } catch {
    return false;
  }
  return false;
}

function resolveRequestPath(pluginId: string, rawPath: unknown): string | null {
  if (typeof rawPath !== "string") {
    return null;
  }
  try {
    const url = new URL(rawPath, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      url.username ||
      url.password ||
      !isPluginOwnedPath(pluginId, url.pathname)
    ) {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function buildRequestInit(rawInit: unknown): RequestInit {
  const init = asRecord(rawInit) ?? {};
  const rawMethod = typeof init.method === "string" ? init.method.trim().toUpperCase() : "GET";
  const method = REQUEST_METHODS.has(rawMethod) ? rawMethod : "GET";
  const headers = new Headers();
  const rawHeaders = asRecord(init.headers);
  if (rawHeaders) {
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (
        typeof value === "string" &&
        name.trim() &&
        !FORBIDDEN_REQUEST_HEADERS.has(name.trim().toLowerCase())
      ) {
        headers.set(name, value);
      }
    }
  }
  return {
    method,
    headers,
    credentials: "same-origin",
    redirect: "error",
    ...(method !== "GET" && method !== "HEAD" && typeof init.body === "string"
      ? { body: init.body }
      : {}),
  };
}

async function proxyRequest(params: {
  fetchImpl: typeof fetch;
  isActive: () => boolean;
  message: PluginUiRequestMessage;
  pluginId: string;
  port: MessagePort;
}) {
  const id = typeof params.message.id === "string" ? params.message.id : "";
  const reply = (payload: Record<string, unknown>) => {
    if (params.isActive()) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin.
      params.port.postMessage({ v: 1, type: "openclaw.pluginUi.response", id, ...payload });
    }
  };
  const path = resolveRequestPath(params.pluginId, params.message.path);
  if (!id || !path) {
    reply({ ok: false, status: 400, statusText: "Bad Request", body: "Invalid plugin request" });
    return;
  }
  try {
    const response = await params.fetchImpl(path, buildRequestInit(params.message.init));
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    reply({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: await response.text(),
    });
  } catch (error) {
    reply({
      ok: false,
      status: 0,
      statusText: "Network Error",
      body: error instanceof Error ? error.message : "Plugin request failed",
    });
  }
}

/** Owns the authenticated parent-side request bridge for one opaque plugin iframe. */
export class PluginUiBridgeController {
  private target: PluginUiBridgeTarget | null = null;
  private port: MessagePort | null = null;
  private bootstrapHandler: ((event: MessageEvent) => void) | null = null;
  private loadHandler: (() => void) | null = null;
  private initialLoadObserved = false;

  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  sync(target: PluginUiBridgeTarget | null) {
    if (
      this.target?.frame === target?.frame &&
      this.target?.key === target?.key &&
      this.target?.pluginId === target?.pluginId &&
      this.target?.src === target?.src
    ) {
      return;
    }
    this.clear();
    if (!target) {
      return;
    }
    this.target = target;
    this.loadHandler = () => {
      if (this.target !== target) {
        return;
      }
      if (!this.initialLoadObserved) {
        this.initialLoadObserved = true;
        return;
      }
      if (this.port) {
        target.onReload?.();
      }
    };
    const bridgeToken = generateUUID();
    this.bootstrapHandler = (event: MessageEvent) => {
      const data = asRecord(event.data);
      if (
        this.target !== target ||
        this.port ||
        event.source !== target.frame.contentWindow ||
        event.ports.length !== 1 ||
        data?.v !== 1 ||
        data?.type !== "openclaw.pluginUi.init" ||
        data.token !== bridgeToken
      ) {
        return;
      }
      const port = event.ports[0];
      if (!port) {
        return;
      }
      window.removeEventListener("message", this.bootstrapHandler!);
      this.bootstrapHandler = null;
      this.port = port;
      port.addEventListener("message", (portEvent: MessageEvent) => {
        const message = portEvent.data as PluginUiRequestMessage | null;
        if (
          this.target !== target ||
          this.port !== port ||
          message?.v !== 1 ||
          message?.type !== "openclaw.pluginUi.request"
        ) {
          return;
        }
        void proxyRequest({
          fetchImpl: this.fetchImpl,
          isActive: () => this.target === target && this.port === port,
          message,
          pluginId: target.pluginId,
          port,
        });
      });
      port.start();
    };
    window.addEventListener("message", this.bootstrapHandler);
    const launchUrl = new URL(target.src, window.location.origin);
    launchUrl.hash = new URLSearchParams({ "openclaw-plugin-ui-bridge": bridgeToken }).toString();
    target.frame.src = `${launchUrl.pathname}${launchUrl.search}${launchUrl.hash}`;
    target.frame.addEventListener("load", this.loadHandler);
  }

  clear() {
    if (this.bootstrapHandler) {
      window.removeEventListener("message", this.bootstrapHandler);
    }
    if (this.target && this.loadHandler) {
      this.target.frame.removeEventListener("load", this.loadHandler);
    }
    this.port?.close();
    this.target = null;
    this.port = null;
    this.bootstrapHandler = null;
    this.loadHandler = null;
    this.initialLoadObserved = false;
  }
}

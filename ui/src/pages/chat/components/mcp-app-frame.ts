/**
 * Minimal MCP Apps host frame (Phase 0): renders a ui:// app document in a
 * sandboxed srcdoc iframe and answers the app's JSON-RPC-over-postMessage
 * handshake (`ui/initialize` → `ui/notifications/initialized` → tool-input +
 * tool-result). App-initiated requests such as tools/call are answered with a
 * JSON-RPC method-not-found error until the full host bridge lands.
 *
 * Security: the iframe runs with `sandbox="allow-scripts"` only — never
 * `allow-same-origin` — so the untrusted document cannot reach the Control UI
 * origin. The app-declared CSP (`_meta.ui.csp`) is injected as a meta tag.
 */
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import type { McpAppToolPreview } from "../../../lib/chat/chat-types.ts";

const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
const APP_FRAME_MIN_HEIGHT = 240;
const APP_FRAME_MAX_HEIGHT = 1200;
const APP_FRAME_DEFAULT_HEIGHT = 480;

// Permission names from `_meta.ui.permissions` mapped to iframe allow features.
const PERMISSION_TO_ALLOW_FEATURE: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

type McpAppHostState = {
  preview: McpAppToolPreview;
  initialized: boolean;
};

// Frames register on load; state is keyed by the iframe element so multiple
// app cards in one chat cannot cross-talk. Entries drop with the DOM nodes.
const appFrameHosts = new WeakMap<HTMLIFrameElement, McpAppHostState>();
const appFrameRegistry = new Set<HTMLIFrameElement>();
let appHostListenerInstalled = false;

function resolveHostTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme-mode") === "light" ? "light" : "dark";
}

function postToApp(frame: HTMLIFrameElement, message: Record<string, unknown>) {
  // srcdoc sandboxed frames have an opaque origin, so "*" is the only valid
  // target; the payload never contains host secrets.
  frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

function sendToolLifecycle(frame: HTMLIFrameElement, state: McpAppHostState) {
  const { toolInput, toolResult } = state.preview;
  postToApp(frame, {
    method: "ui/notifications/tool-input",
    params: {
      arguments:
        toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {},
    },
  });
  postToApp(frame, {
    method: "ui/notifications/tool-result",
    params: {
      content: Array.isArray(toolResult?.content) ? toolResult.content : [],
      ...(toolResult?.structuredContent !== undefined
        ? { structuredContent: toolResult.structuredContent }
        : {}),
      ...(toolResult?._meta !== undefined ? { _meta: toolResult._meta } : {}),
    },
  });
}

function clampAppFrameHeight(raw: number): number {
  return Math.min(Math.max(Math.trunc(raw), APP_FRAME_MIN_HEIGHT), APP_FRAME_MAX_HEIGHT);
}

function handleAppMessage(frame: HTMLIFrameElement, state: McpAppHostState, data: JsonRpcMessage) {
  if (data.method === "ui/initialize" && data.id !== undefined) {
    postToApp(frame, {
      id: data.id,
      result: {
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
        hostInfo: { name: "openclaw-control-ui", version: "0.0.0" },
        hostCapabilities: {},
        hostContext: {
          theme: resolveHostTheme(),
          displayMode: "inline",
          platform: "web",
          containerDimensions: { maxHeight: APP_FRAME_MAX_HEIGHT },
        },
      },
    });
    return;
  }
  if (data.method === "ui/notifications/initialized") {
    if (!state.initialized) {
      state.initialized = true;
      sendToolLifecycle(frame, state);
    }
    return;
  }
  if (data.method === "ui/notifications/size-changed") {
    const height = data.params?.height;
    if (typeof height === "number" && Number.isFinite(height)) {
      const clamped = clampAppFrameHeight(height);
      frame.style.height = `${clamped}px`;
      frame.style.minHeight = `${clamped}px`;
    }
    return;
  }
  if (data.method === "ping" && data.id !== undefined) {
    postToApp(frame, { id: data.id, result: {} });
    return;
  }
  // Requests the Phase 0 host cannot service (tools/call, ui/open-link, …)
  // fail fast so apps can degrade instead of hanging on a silent host.
  if (data.id !== undefined && typeof data.method === "string") {
    postToApp(frame, {
      id: data.id,
      error: {
        code: -32601,
        message: `openclaw does not support "${data.method}" yet`,
      },
    });
  }
}

function installAppHostListener() {
  if (appHostListenerInstalled || typeof window === "undefined") {
    return;
  }
  appHostListenerInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as JsonRpcMessage | null;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") {
      return;
    }
    for (const frame of appFrameRegistry) {
      if (!frame.isConnected) {
        appFrameRegistry.delete(frame);
        continue;
      }
      if (frame.contentWindow === event.source) {
        const state = appFrameHosts.get(frame);
        if (state) {
          handleAppMessage(frame, state, data);
        }
        return;
      }
    }
  });
}

// CSP source expressions accepted from app metadata: scheme://host[:port]
// with an optional single leading wildcard label. Anything else (spaces,
// semicolons, quotes) could smuggle extra directives into the policy string.
const CSP_ORIGIN_PATTERN =
  /^(https?|wss?):\/\/(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

function sanitizeCspOrigins(origins: string[] | undefined): string {
  return (origins ?? []).filter((origin) => CSP_ORIGIN_PATTERN.test(origin)).join(" ");
}

function buildCspContent(preview: McpAppToolPreview): string {
  const resourceOrigins = sanitizeCspOrigins(preview.csp?.resourceDomains);
  const connectOrigins = sanitizeCspOrigins(preview.csp?.connectDomains);
  const frameOrigins = sanitizeCspOrigins(preview.csp?.frameDomains);
  const baseUriOrigins = sanitizeCspOrigins(preview.csp?.baseUriDomains);
  // Spec mapping (deny-by-default): resourceDomains feed static asset
  // directives, connectDomains feed connect-src. Inline scripts/styles and
  // data/blob URLs stay allowed — the document itself is already the trust
  // boundary and self-contained bundles rely on them.
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${resourceOrigins}`.trim(),
    `style-src 'unsafe-inline' ${resourceOrigins}`.trim(),
    `img-src data: blob: ${resourceOrigins}`.trim(),
    `font-src data: ${resourceOrigins}`.trim(),
    `media-src data: blob: ${resourceOrigins}`.trim(),
    `connect-src data: blob: ${connectOrigins}`.trim(),
    `worker-src blob:`,
    frameOrigins ? `frame-src ${frameOrigins}` : `frame-src 'none'`,
    baseUriOrigins ? `base-uri ${baseUriOrigins}` : `base-uri 'none'`,
  ].join("; ");
}

function buildAppSrcdoc(preview: McpAppToolPreview): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildCspContent(preview)}">`;
  const html = preview.html;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${cspMeta}${html.slice(insertAt)}`;
  }
  return `${cspMeta}${html}`;
}

function buildAllowAttribute(preview: McpAppToolPreview): string {
  const features = (preview.permissions ?? [])
    .map((permission) => PERMISSION_TO_ALLOW_FEATURE[permission])
    .filter((feature): feature is string => Boolean(feature));
  return features.join("; ");
}

function registerAppFrame(preview: McpAppToolPreview) {
  // Registration must happen synchronously when the element attaches — before
  // the srcdoc document executes — or an app that connects immediately posts
  // ui/initialize into the void and hangs waiting for the response.
  return (element: Element | undefined) => {
    if (!(element instanceof HTMLIFrameElement)) {
      return;
    }
    installAppHostListener();
    appFrameRegistry.add(element);
    if (!appFrameHosts.has(element)) {
      appFrameHosts.set(element, { preview, initialized: false });
    }
  };
}

/** Renders an MCP App preview panel with its sandboxed host iframe. */
export function renderMcpAppPreview(preview: McpAppToolPreview) {
  if (!preview.html) {
    return nothing;
  }
  const allow = buildAllowAttribute(preview);
  return html`
    <div
      class="chat-tool-card__preview"
      data-kind="mcp-app"
      data-bordered=${preview.prefersBorder ? "true" : nothing}
    >
      <div class="chat-tool-card__preview-header">
        <span class="chat-tool-card__preview-label">${preview.title?.trim() || "App"}</span>
      </div>
      <div class="chat-tool-card__preview-panel" data-side="mcp-app">
        ${keyed(
          preview.resourceUri ?? preview.html.length,
          html`
            <iframe
              class="chat-tool-card__preview-frame chat-tool-card__preview-frame--mcp-app"
              title=${preview.title?.trim() || "MCP app"}
              sandbox="allow-scripts"
              allow=${allow || nothing}
              srcdoc=${buildAppSrcdoc(preview)}
              style="height:${APP_FRAME_DEFAULT_HEIGHT}px;min-height:${APP_FRAME_DEFAULT_HEIGHT}px"
              ${ref(registerAppFrame(preview))}
            ></iframe>
          `,
        )}
      </div>
    </div>
  `;
}

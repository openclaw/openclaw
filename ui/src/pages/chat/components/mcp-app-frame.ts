/**
 * Minimal MCP Apps host frame (Phase 0): renders a ui:// app through the
 * gateway's sandbox proxy and answers the JSON-RPC-over-postMessage handshake.
 * App-initiated requests such as tools/call are rejected until the full host
 * bridge lands.
 */
import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { until } from "lit/directives/until.js";
import {
  CONTROL_UI_BASE_PATH_ATTRIBUTE,
  CONTROL_UI_MCP_APP_RESOURCE_PATH,
  CONTROL_UI_MCP_APP_SANDBOX_PATH,
  CONTROL_UI_MCP_APP_SANDBOX_TICKET_ATTRIBUTE,
  CONTROL_UI_MCP_APP_TICKET_HEADER,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { McpAppToolPreview, ResolvedMcpAppToolPreview } from "../../../lib/chat/chat-types.ts";
import { resolveMcpAppPreviewPayload } from "../../../lib/chat/mcp-app.ts";

const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
const APP_FRAME_MIN_HEIGHT = 240;
const APP_FRAME_MAX_HEIGHT = 1200;
const APP_FRAME_DEFAULT_HEIGHT = 480;
const APP_CSP_MAX_TOTAL_DOMAINS = 32;
const APP_CSP_MAX_ORIGIN_CHARS = 256;
const APP_CSP_ORIGIN_PATTERN =
  /^(https?|wss?):\/\/(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

type McpAppHostState = {
  preview: ResolvedMcpAppToolPreview;
  initialized: boolean;
  resourceSent: boolean;
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
  // The outer sandbox proxy has an opaque origin, so "*" is the only valid
  // target. Source-window checks on both sides prevent cross-frame delivery.
  frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

function sendToolLifecycle(frame: HTMLIFrameElement, state: McpAppHostState) {
  const { toolInput, toolResult } = state.preview;
  const toolResultMeta = toolResult?.["_meta"];
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
      ...(toolResultMeta !== undefined ? { _meta: toolResultMeta } : {}),
    },
  });
}

function clampAppFrameHeight(raw: number): number {
  return Math.min(Math.max(Math.trunc(raw), APP_FRAME_MIN_HEIGHT), APP_FRAME_MAX_HEIGHT);
}

function handleAppMessage(frame: HTMLIFrameElement, state: McpAppHostState, data: JsonRpcMessage) {
  if (data.method === "ui/notifications/sandbox-proxy-ready") {
    if (!state.resourceSent) {
      state.resourceSent = true;
      postToApp(frame, {
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: state.preview.html },
      });
    }
    return;
  }
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

export function buildMcpAppSandboxUrl(params: {
  basePath: string;
  csp?: ResolvedMcpAppToolPreview["csp"];
}): string {
  const search = new URLSearchParams();
  if (params.csp) {
    let remainingDomains = APP_CSP_MAX_TOTAL_DOMAINS;
    const sanitize = (origins: string[] | undefined): string[] | undefined => {
      if (!origins || remainingDomains <= 0) {
        return undefined;
      }
      const values = origins
        .filter(
          (origin) =>
            origin.length <= APP_CSP_MAX_ORIGIN_CHARS && APP_CSP_ORIGIN_PATTERN.test(origin),
        )
        .slice(0, remainingDomains);
      remainingDomains -= values.length;
      return values.length > 0 ? values : undefined;
    };
    const connectDomains = sanitize(params.csp.connectDomains);
    const resourceDomains = sanitize(params.csp.resourceDomains);
    const frameDomains = sanitize(params.csp.frameDomains);
    const baseUriDomains = sanitize(params.csp.baseUriDomains);
    const csp = {
      ...(connectDomains ? { connectDomains } : {}),
      ...(resourceDomains ? { resourceDomains } : {}),
      ...(frameDomains ? { frameDomains } : {}),
      ...(baseUriDomains ? { baseUriDomains } : {}),
    };
    if (Object.keys(csp).length > 0) {
      search.set("csp", JSON.stringify(csp));
    }
  }
  return `${params.basePath}${CONTROL_UI_MCP_APP_SANDBOX_PATH}?${search.toString()}`;
}

export function buildMcpAppResourceUrl(params: { basePath: string; viewId: string }): string {
  const search = new URLSearchParams({ viewId: params.viewId });
  return `${params.basePath}${CONTROL_UI_MCP_APP_RESOURCE_PATH}?${search.toString()}`;
}

function resolveMcpAppAccess(): { basePath: string; ticket: string } | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  const root = document.documentElement;
  const ticket = root.getAttribute(CONTROL_UI_MCP_APP_SANDBOX_TICKET_ATTRIBUTE)?.trim();
  if (!ticket) {
    return undefined;
  }
  return {
    basePath: root.getAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE)?.trim() ?? "",
    ticket,
  };
}

function loadMcpAppView(
  preview: McpAppToolPreview,
  access: { basePath: string; ticket: string },
): Promise<ResolvedMcpAppToolPreview | undefined> {
  return fetch(
    buildMcpAppResourceUrl({
      basePath: access.basePath,
      viewId: preview.viewId,
    }),
    {
      cache: "no-store",
      credentials: "same-origin",
      headers: { [CONTROL_UI_MCP_APP_TICKET_HEADER]: access.ticket },
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        return undefined;
      }
      return resolveMcpAppPreviewPayload(preview, await response.json());
    })
    .catch(() => undefined);
}

function registerAppFrame(preview: ResolvedMcpAppToolPreview) {
  // Registration must happen synchronously when the proxy element attaches so
  // its ready notification cannot race the host listener.
  let registered: HTMLIFrameElement | undefined;
  return (element: Element | undefined) => {
    if (!(element instanceof HTMLIFrameElement)) {
      // Lit invokes the ref with undefined on detach; drop the strong registry
      // entry immediately or multi-MB srcdoc frames outlive their chat view.
      if (registered) {
        appFrameRegistry.delete(registered);
        registered = undefined;
      }
      return;
    }
    installAppHostListener();
    registered = element;
    appFrameRegistry.add(element);
    if (!appFrameHosts.has(element)) {
      appFrameHosts.set(element, { preview, initialized: false, resourceSent: false });
    }
  };
}

function renderMcpAppStatus(
  preview: McpAppToolPreview,
  message: string,
  options: { reloadable?: boolean } = {},
) {
  return html`
    <div class="chat-tool-card__preview" data-kind="mcp-app">
      <div class="chat-tool-card__preview-header">
        <span class="chat-tool-card__preview-label">${preview.title?.trim() || "App"}</span>
        ${options.reloadable
          ? html`
              <button class="btn btn--sm" type="button" @click=${() => window.location.reload()}>
                Reload page
              </button>
            `
          : nothing}
      </div>
      <div class="chat-tool-card__preview-panel" data-side="mcp-app">
        <div class="chat-tool-card__preview-empty">${message}</div>
      </div>
    </div>
  `;
}

function renderResolvedMcpAppPreview(
  preview: ResolvedMcpAppToolPreview,
  access: { basePath: string; ticket: string },
) {
  const sandboxUrl = buildMcpAppSandboxUrl({
    basePath: access.basePath,
    csp: preview.csp,
  });
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
          `${preview.viewId}:${sandboxUrl}`,
          html`
            <iframe
              class="chat-tool-card__preview-frame chat-tool-card__preview-frame--mcp-app"
              title=${preview.title?.trim() || "MCP app"}
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              src=${sandboxUrl}
              style="height:${APP_FRAME_DEFAULT_HEIGHT}px;min-height:${APP_FRAME_DEFAULT_HEIGHT}px"
              ${ref(registerAppFrame(preview))}
            ></iframe>
          `,
        )}
      </div>
    </div>
  `;
}

/** Resolve and render an MCP App preview through the sandboxed host iframe. */
export function renderMcpAppPreview(preview: McpAppToolPreview) {
  const access = resolveMcpAppAccess();
  if (!access) {
    return nothing;
  }
  return guard([preview.viewId, access.basePath, access.ticket], () =>
    until(
      loadMcpAppView(preview, access).then((resolved) =>
        resolved
          ? renderResolvedMcpAppPreview(resolved, access)
          : renderMcpAppStatus(preview, "App preview unavailable. Reload this page to retry.", {
              reloadable: true,
            }),
      ),
      renderMcpAppStatus(preview, "Loading app…"),
    ),
  );
}

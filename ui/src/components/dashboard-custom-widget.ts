// Sandboxed host for approved custom widgets (spec-50 §UI side). Renders the
// `<iframe sandbox="allow-scripts">` and wires the parent side of the postMessage
// bridge (`lib/dashboard/bridge.ts`).
//
// SECURITY INVARIANTS (each has a test — the review gate):
// - The sandbox attribute is the CONSTANT string "allow-scripts". Never config,
//   never `allow-same-origin`/`allow-forms`/`allow-popups`/`allow-top-navigation`.
//   The iframe's origin is therefore opaque (`null`).
// - `referrerpolicy="no-referrer"` — the frame leaks no referrer.
// - The parent accepts a message ONLY when `event.source === iframe.contentWindow`
//   (identity check; the sandboxed origin serializes as "null", so origin strings
//   are never compared). All other windows are dropped.
// - Parent→child posts use targetOrigin "*" (opaque origin) and carry only binding
//   data / theme tokens the manifest entitles the widget to.

import { html, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createWidgetBridge,
  isRpcMethodAllowed,
  type WidgetBridge,
  type WidgetOutboundMessage,
} from "../lib/dashboard/bridge.ts";
import { resolveBinding as resolveDashboardBinding } from "../lib/dashboard/index.ts";
import type {
  DashboardBinding,
  DashboardWidget,
  DashboardWidgetCapability,
  WidgetManifestView,
} from "../lib/dashboard/types.ts";

// Theme tokens exposed to widgets so agent-authored UIs match the active theme
// (00 §7). Read from the document root's computed styles at getTheme time.
const WIDGET_THEME_TOKENS = [
  "--bg",
  "--card",
  "--card-foreground",
  "--text",
  "--muted",
  "--border",
  "--accent",
  "--accent-foreground",
  "--radius",
  "--radius-sm",
  "--font-sans",
  "--font-mono",
] as const;

export type CustomWidgetHostContext = {
  client: GatewayBrowserClient | null;
  /** Gateway HTTP base path (from the app context); "" for same-origin root. */
  basePath: string;
  /** Session key for prompt dispatch via chat.send. */
  sessionKey: string;
  /** Operator confirm dialog quoting the prompt text; resolves true to send. */
  confirmPrompt?: (text: string) => Promise<boolean> | boolean;
  /** Read theme tokens; defaults to computed styles of the document root. */
  readThemeTokens?: () => Record<string, string>;
};

/** Builds the served asset URL for a widget file under the plugin route. */
export function widgetAssetUrl(basePath: string, name: string, file: string): string {
  const base = basePath.replace(/\/+$/, "");
  const encodedName = encodeURIComponent(name);
  const encodedFile = file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/plugins/dashboard/widgets/${encodedName}/${encodedFile}`;
}

function readThemeTokensFromRoot(): Record<string, string> {
  const tokens: Record<string, string> = {};
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return tokens;
  }
  const styles = getComputedStyle(document.documentElement);
  for (const token of WIDGET_THEME_TOKENS) {
    const value = styles.getPropertyValue(token).trim();
    if (value) {
      tokens[token] = value;
    }
  }
  return tokens;
}

function primaryBindingByManifestId(
  widget: DashboardWidget,
  bindingId: string,
): DashboardBinding | null {
  const binding = widget.bindings?.[bindingId];
  return binding ?? null;
}

/** Fetches and shapes a widget's manifest into the bridge's read model. */
export async function loadWidgetManifestView(
  basePath: string,
  name: string,
): Promise<WidgetManifestView | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  try {
    const res = await fetch(widgetAssetUrl(basePath, name, "widget.json"), {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return null;
    }
    const parsed: unknown = await res.json();
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const bindings = Array.isArray(record.bindings) ? record.bindings : [];
    const bindingIds = bindings
      .map((binding) =>
        typeof binding === "object" && binding !== null
          ? (binding as Record<string, unknown>).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string");
    const capabilities = (Array.isArray(record.capabilities) ? record.capabilities : []).filter(
      (cap): cap is DashboardWidgetCapability => cap === "data:read" || cap === "prompt:send",
    );
    return { name, bindingIds, capabilities };
  } catch {
    return null;
  }
}

/**
 * Wires the parent bridge for one iframe: manifest gating, binding resolution over
 * the trusted gateway client, theme tokens, and prompt dispatch. The returned
 * teardown removes the window listener and disposes the bridge.
 */
export function attachWidgetBridge(params: {
  iframe: HTMLIFrameElement;
  widget: DashboardWidget;
  manifest: WidgetManifestView;
  context: CustomWidgetHostContext;
}): () => void {
  const { iframe, widget, manifest, context } = params;
  const post = (message: WidgetOutboundMessage): void => {
    // targetOrigin "*" is required for an opaque (sandboxed) child origin; only
    // manifest-entitled binding data / theme tokens are ever posted.
    iframe.contentWindow?.postMessage(message, "*");
  };
  const bridge: WidgetBridge = createWidgetBridge({
    manifest,
    post,
    assertBindingAllowed: (bindingId) => {
      // Resolve-time defense-in-depth: an rpc binding may only name a method in the
      // read allowlist, re-checked here before the parent ever calls the gateway on
      // the widget's behalf (the write-time schema gate is the first line). A miss
      // returns the same binding_denied the bridge uses for undeclared bindings, and
      // the bridge then skips resolveBinding entirely (no gateway call).
      const binding = primaryBindingByManifestId(widget, bindingId);
      if (binding?.source === "rpc" && !isRpcMethodAllowed(binding.method ?? "")) {
        return "binding_denied";
      }
      return null;
    },
    resolveBinding: async (bindingId) => {
      const binding = primaryBindingByManifestId(widget, bindingId);
      if (!binding) {
        throw new Error(`binding not configured: ${bindingId}`);
      }
      const result = await resolveDashboardBinding(context.client, binding);
      if ("error" in result) {
        throw new Error(result.error);
      }
      return result.value;
    },
    resolveTheme: context.readThemeTokens ?? readThemeTokensFromRoot,
    confirmPrompt: async (text) => {
      if (context.confirmPrompt) {
        return await context.confirmPrompt(text);
      }
      return typeof window !== "undefined" ? window.confirm(text) : false;
    },
    sendPrompt: async (text) => {
      if (!context.client) {
        throw new Error("Not connected.");
      }
      await context.client.request("chat.send", {
        sessionKey: context.sessionKey,
        message: text,
        deliver: false,
      });
    },
  });

  const onMessage = (event: MessageEvent): void => {
    // IDENTITY accept filter — never compare origin strings (opaque origin = null).
    if (event.source !== iframe.contentWindow) {
      return;
    }
    bridge.handleMessage(event.data);
  };
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    bridge.dispose();
  };
}

/**
 * Lit directive that owns the iframe element's lifecycle: it constructs the
 * sandboxed iframe once, attaches the bridge, and tears both down on disconnect.
 * Using a directive (rather than re-rendering an `<iframe>` template) keeps the
 * frame from being recreated on every parent render, which would drop bridge
 * state and reload the widget.
 */
class CustomWidgetFrameDirective extends AsyncDirective {
  private iframe: HTMLIFrameElement | null = null;
  private detach: (() => void) | null = null;
  private key = "";

  render(params: {
    widget: DashboardWidget;
    manifest: WidgetManifestView;
    context: CustomWidgetHostContext;
  }): HTMLIFrameElement {
    const name = params.widget.kind.slice("custom:".length);
    const src = widgetAssetUrl(params.context.basePath, name, "index.html");
    const nextKey = `${params.widget.id}::${src}`;
    if (this.iframe && this.key === nextKey) {
      return this.iframe;
    }
    this.detach?.();
    const iframe = document.createElement("iframe");
    // CONSTANT sandbox — do not templatize. Only script execution is granted.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    iframe.className = "dashboard-widget__frame";
    iframe.title = params.widget.title;
    iframe.src = src;
    iframe.setAttribute("data-test-id", "dashboard-custom-widget-frame");
    this.detach = attachWidgetBridge({
      iframe,
      widget: params.widget,
      manifest: params.manifest,
      context: params.context,
    });
    this.iframe = iframe;
    this.key = nextKey;
    return iframe;
  }

  override disconnected(): void {
    this.detach?.();
    this.detach = null;
    this.iframe = null;
    this.key = "";
  }
}

const customWidgetFrame = directive(CustomWidgetFrameDirective);

/** Renders the sandboxed iframe host for an approved custom widget. */
export function renderCustomWidgetHost(params: {
  widget: DashboardWidget;
  manifest: WidgetManifestView;
  context: CustomWidgetHostContext;
}): TemplateResult {
  return html`<div class="dashboard-widget__custom" data-test-id="dashboard-custom-widget">
    ${customWidgetFrame(params)}
  </div>`;
}

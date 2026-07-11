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
// - Parent→child posts use targetOrigin "*" (opaque origin) and carry only static
//   workspace values / theme tokens the manifest entitles the widget to. Privileged
//   RPC/file data never enters agent-authored code: sandboxed children can navigate.

import { html, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createWidgetBridge,
  type WidgetBridge,
  type WidgetOutboundMessage,
} from "../lib/dashboard/bridge.ts";
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

function parseManifestBinding(value: unknown): { id: string; binding: DashboardBinding } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    return null;
  }
  if (record.source === "static" && Object.hasOwn(record, "value")) {
    return { id, binding: { source: "static", value: record.value } };
  }
  return null;
}

/** Custom code may receive only static workspace values granted by its manifest. */
function bindingMatchesManifestGrant(binding: DashboardBinding, grant: DashboardBinding): boolean {
  return binding.source === "static" && grant.source === "static";
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
    const manifestBindings = Array.isArray(record.bindings) ? record.bindings : [];
    // Binding ids may legally be `__proto__`; a null-prototype record represents
    // every allowed id without invoking Object.prototype's legacy setter.
    const bindings = Object.create(null) as Record<string, DashboardBinding>;
    for (const value of manifestBindings) {
      const parsedBinding = parseManifestBinding(value);
      if (!parsedBinding || Object.hasOwn(bindings, parsedBinding.id)) {
        return null;
      }
      bindings[parsedBinding.id] = parsedBinding.binding;
    }
    const capabilities = (Array.isArray(record.capabilities) ? record.capabilities : []).filter(
      (cap): cap is DashboardWidgetCapability => cap === "data:read" || cap === "prompt:send",
    );
    // The approval gate hashes the manifest's declared entrypoint. Loading a
    // different file would mount code the operator never approved.
    const entrypoint = typeof record.entrypoint === "string" ? record.entrypoint : "";
    if (!entrypoint) {
      return null;
    }
    return { name, entrypoint, bindings, capabilities };
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
      // Agent-authored frames can navigate themselves despite their sandbox/CSP.
      // Never place privileged RPC/file data in them; built-in widgets own those
      // bindings. Static values are already agent/operator-authored workspace data.
      const binding = primaryBindingByManifestId(widget, bindingId);
      const grant = manifest.bindings[bindingId];
      if (!binding || !grant || !bindingMatchesManifestGrant(binding, grant)) {
        return "binding_denied";
      }
      return null;
    },
    resolveBinding: async (bindingId) => {
      const binding = primaryBindingByManifestId(widget, bindingId);
      if (!binding) {
        throw new Error(`binding not configured: ${bindingId}`);
      }
      if (binding.source !== "static") {
        throw new Error(`binding not allowed: ${bindingId}`);
      }
      return binding.value;
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
  }): HTMLElement {
    const name = params.widget.kind.slice("custom:".length);
    const src = widgetAssetUrl(params.context.basePath, name, params.manifest.entrypoint);
    const nextKey = `${params.widget.id}::${src}`;
    if (this.iframe && this.key === nextKey) {
      return this.iframe;
    }
    this.detach?.();
    try {
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
    } catch (error) {
      // A directive's render runs at Lit COMMIT time, outside the try/catch in
      // `renderWidgetBody`. A throw here would escape the per-cell error boundary
      // and take down the whole tab, so the boundary has to exist here too.
      this.detach = null;
      this.iframe = null;
      this.key = "";
      const fallback = document.createElement("div");
      fallback.className = "dashboard-widget__error";
      fallback.setAttribute("role", "alert");
      fallback.setAttribute("data-test-id", "dashboard-custom-widget-error");
      fallback.textContent = error instanceof Error ? error.message : String(error);
      return fallback;
    }
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

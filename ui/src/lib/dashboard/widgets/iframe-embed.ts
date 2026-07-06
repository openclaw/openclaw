// builtin:iframe-embed — an embedded URL (dev-server preview, hosted report).
// `props.url` supplies the src. The frame is sandboxed via
// `resolveEmbedSandbox(config.embedSandboxMode)` and external http(s) URLs are
// blocked unless `config.allowExternalEmbedUrls` — mirroring the chat embed
// policy exactly (see ui/src/lib/chat/tool-display.ts + ui/src/app/config.ts).

import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../chat/tool-display.ts";
import type { DashboardWidget } from "../types.ts";
import type { BuiltinWidgetContext } from "./types.ts";
import { widgetProps } from "./types.ts";

export type EmbedUrlDecision =
  | { status: "missing" }
  | { status: "blocked"; reason: "external" | "scheme"; url: string }
  | { status: "ok"; url: string; external: boolean };

/**
 * Resolve `props.url` against the embed policy. Relative URLs and same-origin
 * absolute URLs are internal and always allowed. Absolute http(s) URLs to a
 * different origin are external and require `allowExternalEmbedUrls`. Any other
 * scheme (javascript:, data:, file:, …) is rejected outright.
 */
export function evaluateEmbedUrl(
  rawUrl: unknown,
  policy: { allowExternalEmbedUrls: boolean },
  origin?: string,
): EmbedUrlDecision {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { status: "missing" };
  }
  const url = rawUrl.trim();
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : undefined);
  let parsed: URL;
  try {
    // A relative URL resolves against the current origin; an absolute URL keeps
    // its own. Without a base, relative URLs cannot be classified — treat as
    // internal (they cannot escape the current document).
    parsed = base ? new URL(url, base) : new URL(url);
  } catch {
    // Relative URL with no base to resolve against: internal by construction.
    return { status: "ok", url, external: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "blocked", reason: "scheme", url };
  }
  const external = base ? parsed.origin !== new URL(base).origin : true;
  if (external && !policy.allowExternalEmbedUrls) {
    return { status: "blocked", reason: "external", url };
  }
  return { status: "ok", url, external };
}

export function renderIframeEmbed(
  widget: DashboardWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const decision = evaluateEmbedUrl(widgetProps(widget).url, {
    allowExternalEmbedUrls: ctx.embed.allowExternalEmbedUrls,
  });
  if (decision.status === "missing") {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.embed.missing")}
    </div>`;
  }
  if (decision.status === "blocked") {
    return html`<div class="dashboard-widget__placeholder" data-test-id="dashboard-embed-blocked">
      ${decision.reason === "external"
        ? t("dashboard.widget.embed.blockedExternal")
        : t("dashboard.widget.embed.blockedScheme")}
    </div>`;
  }
  return html`<iframe
    class="dashboard-embed__frame"
    data-test-id="dashboard-embed-frame"
    src=${decision.url}
    title=${widget.title}
    sandbox=${resolveEmbedSandbox(ctx.embed.embedSandboxMode)}
    referrerpolicy="no-referrer"
    loading="lazy"
  ></iframe>`;
}

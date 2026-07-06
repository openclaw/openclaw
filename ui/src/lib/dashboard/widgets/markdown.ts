// builtin:markdown — renders a markdown body from a `content` binding (file /
// static) or `props.markdown` / `props.text`. Reuses the repo's sanitizing
// markdown util so the same allowlist/sanitizer governs dashboard and chat.

import { html, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { DashboardWidget } from "../types.ts";
import { widgetProps } from "./types.ts";

export function mapMarkdownSource(widget: DashboardWidget, value: unknown): string {
  const props = widgetProps(widget);
  if (typeof value === "string") {
    return value;
  }
  if (typeof props.markdown === "string") {
    return props.markdown;
  }
  if (typeof props.text === "string") {
    return props.text;
  }
  return "";
}

export function renderMarkdown(widget: DashboardWidget, value: unknown): TemplateResult {
  const source = mapMarkdownSource(widget, value);
  if (!source.trim()) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.markdownEmpty")}
    </div>`;
  }
  return html`<div class="dashboard-markdown markdown-body">
    ${unsafeHTML(toSanitizedMarkdownHtml(source))}
  </div>`;
}

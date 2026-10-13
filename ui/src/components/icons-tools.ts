import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { keyboardIconData, toolIconData } from "./icon-data-tools.ts";
import type { IconData, IconNode } from "./icon-data-types.ts";

// Shared Lucide icon shell. Inline presentation attributes keep icons visible
// inside shadow roots that global stylesheet icon rules cannot reach; CSS
// rules still override them where a surface wants a different stroke width.
// Bodies must be svg`` fragments: html`` would parse the shapes outside the
// SVG namespace and they would silently render as nothing.
export function strokeIcon(body: SVGTemplateResult, style?: string): TemplateResult {
  return html`
    <svg
      viewBox="0 0 24 24"
      style=${style ?? nothing}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      ${body}
    </svg>
  `;
}

export const keyboardIconShapes = {
  "⌘": renderIconShapes(keyboardIconData["⌘"]),
  "⌥": renderIconShapes(keyboardIconData["⌥"]),
  "⇧": renderIconShapes(keyboardIconData["⇧"]),
  "⌃": renderIconShapes(keyboardIconData["⌃"]),
  "⏎": renderIconShapes(keyboardIconData["⏎"]),
  "↑": renderIconShapes(keyboardIconData["↑"]),
  "↓": renderIconShapes(keyboardIconData["↓"]),
  "←": renderIconShapes(keyboardIconData["←"]),
  "→": renderIconShapes(keyboardIconData["→"]),
};

export const toolIcons = renderIconRegistry(toolIconData);

function iconMarkup(nodes: readonly IconNode[]): string {
  return nodes
    .map(([tag, attributes, children]) => {
      const attrs = Object.entries(attributes)
        .map(
          ([key, value]) =>
            ` ${key}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`,
        )
        .join("");
      return `<${tag}${attrs}>${children ? iconMarkup(children) : ""}</${tag}>`;
    })
    .join("");
}

function renderIconShapes(nodes: readonly IconNode[]) {
  // Only the built-in geometry catalog supplies nodes; external SVG uses its sanitizer.
  return svg`${unsafeSVG(iconMarkup(nodes))}`;
}

function renderIconData({ attributes: a, children }: IconData): TemplateResult {
  return svg`<svg
    viewBox=${a.viewBox ?? nothing}
    fill=${a.fill ?? nothing}
    stroke=${a.stroke ?? nothing}
    stroke-width=${a["stroke-width"] ?? nothing}
    stroke-linecap=${a["stroke-linecap"] ?? nothing}
    stroke-linejoin=${a["stroke-linejoin"] ?? nothing}
    style=${a.style ?? nothing}
    class=${a.class ?? nothing}
    width=${a.width ?? nothing}
    height=${a.height ?? nothing}
    aria-hidden=${a["aria-hidden"] ?? nothing}
  >${renderIconShapes(children)}</svg>`;
}

export function renderIconRegistry<Name extends string>(data: Record<Name, IconData>) {
  const entries = Object.fromEntries(
    Object.entries<IconData>(data).map(([name, icon]) => [name, renderIconData(icon)]),
  );
  // SAFETY: Mapping values retains every key of this source-owned registry.
  return entries as Record<Name, TemplateResult>;
}

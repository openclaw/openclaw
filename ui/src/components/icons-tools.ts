import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { keyboardIconData, toolIconData } from "./icon-data-tools.ts";
import type { IconAttributes, IconData, IconNode } from "./icon-data-types.ts";

function attributesMarkup(attributes: IconAttributes): string {
  return Object.entries(attributes)
    .map(([name, value]) => {
      const escaped = String(value).replace(/[&"<>]/g, (character) => {
        switch (character) {
          case "&":
            return "&amp;";
          case '"':
            return "&quot;";
          case "<":
            return "&lt;";
          default:
            return "&gt;";
        }
      });
      return `${name}="${escaped}"`;
    })
    .join(" ");
}

function nodesMarkup(nodes: readonly IconNode[]): string {
  return nodes
    .map(
      ([tag, attributes, children]) =>
        `<${tag} ${attributesMarkup(attributes)}>${children ? nodesMarkup(children) : ""}</${tag}>`,
    )
    .join("");
}

/** Only the source-owned, typed icon catalog supplies tags and attribute names. */
function renderIconNodes(nodes: readonly IconNode[]): SVGTemplateResult {
  return svg`${unsafeSVG(nodesMarkup(nodes))}`;
}

export function createIconTemplates<const T extends Record<string, IconData>>(
  catalog: T,
): { readonly [K in keyof T]: TemplateResult } {
  // Values are escaped; these static SVG templates are not a user-content renderer.
  const entries = Object.entries(catalog).map(([name, data]) => [
    name,
    html`${unsafeSVG(`<svg ${attributesMarkup(data.attributes)}>${nodesMarkup(data.children)}</svg>`)}`,
  ]);
  // SAFETY: Object.entries maps every catalog key once, preserving the exact key set.
  return Object.fromEntries(entries) as { readonly [K in keyof T]: TemplateResult };
}

// Keep inline presentation attributes for custom icons rendered inside shadow roots.
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

export const keyboardIconShapes = Object.fromEntries(
  Object.entries(keyboardIconData).map(([key, nodes]) => [key, renderIconNodes(nodes)]),
) as { readonly [K in keyof typeof keyboardIconData]: SVGTemplateResult }; // SAFETY: Mapping preserves every catalog key.

export const toolIcons = createIconTemplates(toolIconData);

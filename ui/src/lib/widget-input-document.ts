import { html as htmlNamespaces, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { WIDGET_BASE_STYLES } from "../../../src/shared/widget-base-styles.js";
import { WIDGET_THEME_TOKENS } from "../../../src/shared/widget-theme.js";

export type WidgetInputNode =
  | string
  | {
      tag: string;
      namespace: string;
      attributes: [string, string][];
      children: WidgetInputNode[];
    };

const HTML_NAMESPACE = htmlNamespaces.NS.HTML;
const SVG_NAMESPACE = htmlNamespaces.NS.SVG;
const HTML_TAGS = new Set(
  "div span p h1 h2 h3 h4 h5 h6 section main article aside header footer nav ul ol li dl dt dd figure figcaption table thead tbody tfoot tr th td colgroup col br hr pre code strong em b i small sup sub mark blockquote a button input select option textarea label output meter progress details summary style".split(
    " ",
  ),
);
const SVG_TAGS = new Set(
  "svg g defs title desc style path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop clipPath mask pattern marker symbol use filter feGaussianBlur feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode".split(
    " ",
  ),
);
const ATTRIBUTES = new Set(
  "id class style title role hidden width height colspan rowspan scope open disabled value min max low high optimum type placeholder selected checked x y x1 y1 x2 y2 cx cy r rx ry viewBox d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity transform preserveAspectRatio offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod clip-path clipPathUnits mask maskUnits patternUnits patternContentUnits patternTransform markerWidth markerHeight refX refY orient marker-start marker-mid marker-end text-anchor dominant-baseline font-size font-family font-weight letter-spacing dx dy startOffset filter filterUnits in in2 result stdDeviation mode values operator flood-color flood-opacity".split(
    " ",
  ),
);
const DROP_CONTENT = new Set(["script", "iframe", "object", "embed", "template", "noscript"]);

/** Parse inertly: no generated markup is ever assigned to a main-origin DOM sink. */
export function parseWidgetInputDocument(html: string): WidgetInputNode[] {
  let remainingNodes = 4096;
  const visit = (nodes: DefaultTreeAdapterMap["childNode"][], depth: number): WidgetInputNode[] => {
    if (depth > 128) {
      return [];
    }
    const result: WidgetInputNode[] = [];
    for (const node of nodes) {
      if (--remainingNodes < 0) {
        break;
      }
      if (node.nodeName === "#text" && "value" in node) {
        result.push(node.value);
      } else if ("tagName" in node && !DROP_CONTENT.has(node.tagName)) {
        const allowed =
          node.namespaceURI === HTML_NAMESPACE
            ? HTML_TAGS
            : node.namespaceURI === SVG_NAMESPACE
              ? SVG_TAGS
              : undefined;
        if (!allowed?.has(node.tagName)) {
          continue;
        }
        result.push({
          tag: node.tagName,
          namespace: node.namespaceURI,
          // No resource, navigation, event-handler, or host-capability attributes.
          attributes: node.attrs
            .filter(
              (attr) =>
                !attr.namespace && (ATTRIBUTES.has(attr.name) || attr.name.startsWith("aria-")),
            )
            .map(({ name, value }) => [name, value]),
          children: visit(node.childNodes, depth + 1),
        });
      }
    }
    return result;
  };
  return visit(parseFragment(html).childNodes, 0);
}

export function buildWidgetInputShell(nonce: string, runtimeUrl: string): string {
  // The external classic asset satisfies the parent page CSP inherited by srcdoc.
  // The inner policy admits only this nonce; generated resources remain blocked.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none';"><style>${WIDGET_BASE_STYLES}html{overflow:hidden}body{pointer-events:none}</style></head><body><script nonce="${nonce}" src="${escapeHtml(runtimeUrl)}" data-theme-tokens="${WIDGET_THEME_TOKENS.join(" ")}"></script></body></html>`;
}

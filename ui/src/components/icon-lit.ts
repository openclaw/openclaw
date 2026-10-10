import { nothing, svg, type SVGTemplateResult } from "lit";
import type { IconData, IconNode } from "./icon-data-types.ts";

export function renderIconNodes(nodes: readonly IconNode[]): SVGTemplateResult {
  return svg`${nodes.map(renderIconNode)}`;
}

function renderIconNode(node: IconNode): SVGTemplateResult {
  const [tag, attributes, children] = node;
  switch (tag) {
    case "path":
      return svg`<path
        class=${attributes["class"] ?? nothing}
        d=${attributes["d"] ?? nothing}
        fill=${attributes["fill"] ?? nothing}
        stroke-linecap=${attributes["stroke-linecap"] ?? nothing}
        stroke-linejoin=${attributes["stroke-linejoin"] ?? nothing}
        stroke-width=${attributes["stroke-width"] ?? nothing}
        style=${attributes["style"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</path>`;
    case "polyline":
      return svg`<polyline
        points=${attributes["points"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</polyline>`;
    case "rect":
      return svg`<rect
        height=${attributes["height"] ?? nothing}
        rx=${attributes["rx"] ?? nothing}
        ry=${attributes["ry"] ?? nothing}
        style=${attributes["style"] ?? nothing}
        width=${attributes["width"] ?? nothing}
        x=${attributes["x"] ?? nothing}
        y=${attributes["y"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</rect>`;
    case "circle":
      return svg`<circle
        cx=${attributes["cx"] ?? nothing}
        cy=${attributes["cy"] ?? nothing}
        fill=${attributes["fill"] ?? nothing}
        r=${attributes["r"] ?? nothing}
        stroke=${attributes["stroke"] ?? nothing}
        style=${attributes["style"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</circle>`;
    case "line":
      return svg`<line
        x1=${attributes["x1"] ?? nothing}
        x2=${attributes["x2"] ?? nothing}
        y1=${attributes["y1"] ?? nothing}
        y2=${attributes["y2"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</line>`;
    case "polygon":
      return svg`<polygon
        points=${attributes["points"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</polygon>`;
    case "defs":
      return svg`<defs
      >${children ? renderIconNodes(children) : nothing}</defs>`;
    case "linearGradient":
      return svg`<linearGradient
        id=${attributes["id"] ?? nothing}
        x1=${attributes["x1"] ?? nothing}
        x2=${attributes["x2"] ?? nothing}
        y1=${attributes["y1"] ?? nothing}
        y2=${attributes["y2"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</linearGradient>`;
    case "stop":
      return svg`<stop
        offset=${attributes["offset"] ?? nothing}
        style=${attributes["style"] ?? nothing}
      >${children ? renderIconNodes(children) : nothing}</stop>`;
  }
}

export function renderIconData(data: IconData): SVGTemplateResult {
  const attributes = data.attributes;
  return svg`<svg
    aria-hidden=${attributes["aria-hidden"] ?? nothing}
    class=${attributes["class"] ?? nothing}
    fill=${attributes["fill"] ?? nothing}
    height=${attributes["height"] ?? nothing}
    stroke=${attributes["stroke"] ?? nothing}
    stroke-linecap=${attributes["stroke-linecap"] ?? nothing}
    stroke-linejoin=${attributes["stroke-linejoin"] ?? nothing}
    stroke-width=${attributes["stroke-width"] ?? nothing}
    viewBox=${attributes["viewBox"] ?? nothing}
    width=${attributes["width"] ?? nothing}
  >${renderIconNodes(data.children)}</svg>`;
}

import type { IconAttributes, IconNode } from "./icon-data-types.ts";
import { iconData, type IconName } from "./icon-data.ts";

/** Imperative DOM islands own these nodes without a component render root. */
export function createIconElement(name: IconName, ownerDocument: Document): SVGSVGElement {
  const data = iconData[name];
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  const setAttributes = (element: SVGElement, attributes: IconAttributes) => {
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
  };
  const appendShapes = (element: SVGElement, shapes: readonly IconNode[]) => {
    for (const [tag, attributes, children] of shapes) {
      const shape = ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag);
      setAttributes(shape, attributes);
      appendShapes(shape, children ?? []);
      element.append(shape);
    }
  };
  setAttributes(svg, data.attributes);
  svg.setAttribute("aria-hidden", "true");
  appendShapes(svg, data.children);
  return svg;
}

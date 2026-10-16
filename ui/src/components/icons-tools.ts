import { toolIconData } from "./icon-data-tools.ts";
import type { IconAttributes, IconData, IconNode } from "./icon-data-types.ts";

export const toolIcons = renderIconRegistry(toolIconData);

function renderIconNode(
  tag: string,
  attributes: IconAttributes,
  children: readonly IconNode[] = [],
) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      node.setAttribute(name, String(value));
    }
  }
  node.append(...children.map(([name, attrs, nodes]) => renderIconNode(name, attrs, nodes)));
  return node;
}

function renderIconRegistry<Name extends string>(data: Record<Name, IconData>) {
  const entries = Object.fromEntries(
    Object.entries<IconData>(data).map(([name, icon]) => [
      name,
      // Stored icons can appear in multiple places; each Solid insertion owns its nodes.
      () => renderIconNode("svg", icon.attributes, icon.children),
    ]),
  );
  // SAFETY: Mapping values retains every key of this source-owned registry.
  return entries as Record<Name, () => SVGElement>;
}

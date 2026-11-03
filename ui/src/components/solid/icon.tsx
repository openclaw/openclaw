import { dynamic, type JSX } from "@solidjs/web";
import { For } from "solid-js";
import { brandIconData, type BrandIconName } from "../icon-data-brand.ts";
import { keyboardIconData, type KeyboardIconSymbol } from "../icon-data-tools.ts";
import { strokeIconData, type IconData, type IconNode } from "../icon-data-types.ts";
import { iconData, type IconName } from "../icon-data.ts";

export type { BrandIconName } from "../icon-data-brand.ts";
export { hasKeyboardIcon, type KeyboardIconSymbol } from "../icon-data-tools.ts";
export type { IconName } from "../icon-data.ts";

const masks = new Map<string, string>();
/** Immutable artwork is shared; these display-only glyphs need no reactive subtree. */
export function sessionIconMask(name: IconName, stroke = 2): string {
  const key = `${name}:${stroke}`;
  let mask = masks.get(key);
  if (!mask) {
    const attributes = (values: IconData["attributes"]) =>
      Object.entries(values)
        .map(([attribute, value]) => ` ${attribute}="${value}"`)
        .join("");
    const node = ([tag, values, children]: IconNode): string =>
      `<${tag}${attributes(values)}>${children?.map(node).join("") ?? ""}</${tag}>`;
    const data = iconData[name];
    mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"${attributes({ ...data.attributes, stroke: "black", "stroke-width": stroke })}>${data.children.map(node).join("")}</svg>`)}")`;
    masks.set(key, mask);
  }
  return mask;
}

export function sessionIcon(name: IconName, size = 12, stroke = 2): HTMLElement {
  const element = document.createElement("i");
  element.className = "session-css-icon";
  element.setAttribute("aria-hidden", "true");
  if (size !== 12) {
    element.style.cssText = `width:${size}px;height:${size}px`;
  }
  element.style.maskImage = sessionIconMask(name, stroke);
  return element;
}

type IconPresentation = {
  class?: string;
  style?: string | JSX.CSSProperties;
  "aria-label"?: string;
};

function IconShape(props: { node: IconNode }) {
  const Shape = dynamic(() => props.node[0]);
  return (
    <Shape {...props.node[1]}>
      <For each={props.node[2]}>{(node) => <IconShape node={node} />}</For>
    </Shape>
  );
}

function IconSvg(props: IconPresentation & { data: IconData }) {
  return (
    <svg
      {...props.data.attributes}
      class={[props.data.attributes.class, props.class]}
      style={props.style}
      aria-hidden={props["aria-label"] ? undefined : "true"}
      aria-label={props["aria-label"]}
      role={props["aria-label"] ? "img" : undefined}
    >
      <For each={props.data.children}>{(node) => <IconShape node={node} />}</For>
    </svg>
  );
}

export function Icon(props: IconPresentation & { name: IconName }) {
  return <IconSvg {...props} data={iconData[props.name]} />;
}

export function KeyboardIcon(props: IconPresentation & { symbol: KeyboardIconSymbol }) {
  return <IconSvg {...props} data={strokeIconData(keyboardIconData[props.symbol])} />;
}

export function BrandIcon(props: IconPresentation & { name: BrandIconName }) {
  return <IconSvg {...props} data={brandIconData[props.name]} />;
}

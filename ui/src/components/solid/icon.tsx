import { dynamic, type JSX } from "@solidjs/web";
import { For } from "solid-js";
import { brandIconData, type BrandIconName } from "../icon-data-brand.ts";
import { keyboardIconData, type KeyboardIconSymbol } from "../icon-data-tools.ts";
import { strokeIconData, type IconData, type IconNode } from "../icon-data-types.ts";
import { iconData, type IconName } from "../icon-data.ts";

export type { BrandIconName } from "../icon-data-brand.ts";
export { hasKeyboardIcon, type KeyboardIconSymbol } from "../icon-data-tools.ts";
export type { IconName } from "../icon-data.ts";

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

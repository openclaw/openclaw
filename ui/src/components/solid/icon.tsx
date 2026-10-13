import type { JSX } from "@solidjs/web";
import { For, Match, Switch } from "solid-js";
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
  const children = () => <For each={props.node[2]}>{(node) => <IconShape node={node} />}</For>;
  return (
    <Switch>
      <Match when={props.node[0] === "path"}>
        <path {...props.node[1]}>{children()}</path>
      </Match>
      <Match when={props.node[0] === "rect"}>
        <rect {...props.node[1]}>{children()}</rect>
      </Match>
      <Match when={props.node[0] === "circle"}>
        <circle {...props.node[1]}>{children()}</circle>
      </Match>
      <Match when={props.node[0] === "line"}>
        <line {...props.node[1]}>{children()}</line>
      </Match>
      <Match when={props.node[0] === "polyline"}>
        <polyline {...props.node[1]}>{children()}</polyline>
      </Match>
      <Match when={props.node[0] === "polygon"}>
        <polygon {...props.node[1]}>{children()}</polygon>
      </Match>
      <Match when={props.node[0] === "defs"}>
        <defs {...props.node[1]}>{children()}</defs>
      </Match>
      <Match when={props.node[0] === "linearGradient"}>
        <linearGradient {...props.node[1]}>{children()}</linearGradient>
      </Match>
      <Match when={props.node[0] === "stop"}>
        <stop {...props.node[1]}>{children()}</stop>
      </Match>
    </Switch>
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
  return (
    <IconSvg
      data={iconData[props.name]}
      class={props.class}
      style={props.style}
      aria-label={props["aria-label"]}
    />
  );
}

export function KeyboardIcon(props: IconPresentation & { symbol: KeyboardIconSymbol }) {
  return (
    <IconSvg
      data={strokeIconData(keyboardIconData[props.symbol])}
      class={props.class}
      style={props.style}
      aria-label={props["aria-label"]}
    />
  );
}

export function BrandIcon(props: IconPresentation & { name: BrandIconName }) {
  return (
    <IconSvg
      data={brandIconData[props.name]}
      class={props.class}
      style={props.style}
      aria-label={props["aria-label"]}
    />
  );
}

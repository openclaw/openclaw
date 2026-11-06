import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { Icon, type IconName } from "./icon.tsx";
import "../tooltip.ts";

export type IconButtonSize = 28 | 32 | 36;
export type IconButtonStyle = {
  size?: IconButtonSize;
  /** Chrome glyphs draw at 14px; glyphs inside list and table rows at 15px. */
  glyph?: "chrome" | "row";
};

/** Class contract for icon-only triggers rendered by other primitives, such as menu triggers. */
export function iconButtonClass(style: IconButtonStyle = {}): string {
  return [
    "oc-icon-button",
    `oc-icon-button--${style.size ?? 32}`,
    style.glyph === "row" ? "oc-icon-button--row-glyph" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

type ButtonAttributes = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "aria-pressed" | "children" | "class" | "title"
> & {
  [name: `data-${string}`]: string | number | boolean | undefined;
};

export type IconButtonProps = ButtonAttributes &
  IconButtonStyle & {
    /** Accessible name; also the tooltip unless `tooltip` replaces or disables it. */
    label: string;
    icon: IconName | JSX.Element;
    /** Pass for toggles: the button reports and paints its on state. */
    pressed?: boolean;
    busy?: boolean;
    /** Tooltip copy; `false` when the surface already explains the action. */
    tooltip?: string | false;
    class?: JSX.ClassValue;
  };

/** One icon-only action: a fixed box, a 14/15px glyph, and the app's hover, pressed and focus states. */
export function IconButton(props: IconButtonProps) {
  const attributes = omit(
    props,
    "label",
    "icon",
    "pressed",
    "busy",
    "tooltip",
    "class",
    "size",
    "glyph",
    "type",
  );
  const button = (
    <button
      {...attributes}
      type={props.type ?? "button"}
      class={[iconButtonClass(props), props.class]}
      aria-label={props.label}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
      aria-busy={props.busy ? "true" : undefined}
    >
      {typeof props.icon === "string" ? <Icon name={props.icon as IconName} /> : props.icon}
    </button>
  );
  return props.tooltip === false ? (
    button
  ) : (
    <openclaw-tooltip prop:content={props.tooltip || props.label}>{button}</openclaw-tooltip>
  );
}

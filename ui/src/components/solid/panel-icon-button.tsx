import type { JSX } from "@solidjs/web";
import { IconButton, type IconButtonProps } from "./icon-button.tsx";

/** A panel header action: an IconButton at the rail's 28px box. */
export function PanelIconButton(props: {
  label: string;
  icon: IconButtonProps["icon"];
  onClick: () => void;
  class: JSX.ClassValue;
  /** Tooltip copy; `false` when the icon already says what the button does. */
  title?: string | false;
  disabled?: boolean;
  busy?: boolean;
  pressed?: boolean;
  newTab?: boolean;
}) {
  return (
    <IconButton
      size={28}
      class={props.class}
      icon={props.icon}
      label={props.label}
      tooltip={props.title ?? props.label}
      data-new-tab-action={props.newTab ? "" : undefined}
      pressed={props.pressed}
      disabled={props.disabled}
      busy={props.busy}
      onClick={() => props.onClick()}
    />
  );
}

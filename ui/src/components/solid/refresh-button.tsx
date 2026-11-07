import type { JSX } from "@solidjs/web";
import { IconButton } from "./icon-button.tsx";

/** Reloads a page's or section's data: a quiet icon that keeps its box while it spins. */
export function RefreshButton(props: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Replaces the label in the tooltip, for example to add the last update time. */
  tooltip?: string;
  class?: JSX.ClassValue;
}) {
  return (
    <IconButton
      class={["refresh-button", props.class]}
      icon="refresh"
      label={props.label}
      tooltip={props.tooltip}
      busy={props.busy}
      disabled={props.busy || props.disabled}
      onClick={() => props.onClick()}
    />
  );
}

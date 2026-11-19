import type { JSX } from "@solidjs/web";
import { IconButton } from "./icon-button.tsx";

/** Reloads a page's or section's data: a quiet icon that keeps its box while it spins. */
export function RefreshButton(props: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Optional tooltip, such as the last update time; the refresh icon needs no label. */
  tooltip?: string;
  class?: JSX.ClassValue;
}) {
  return (
    <IconButton
      class={["refresh-button", props.class]}
      icon="refresh"
      label={props.label}
      tooltip={props.tooltip || false}
      busy={props.busy}
      disabled={props.busy || props.disabled}
      onClick={() => props.onClick()}
    />
  );
}

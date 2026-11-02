import type { JSX } from "@solidjs/web";
import { Icon } from "./icon.tsx";

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
    <openclaw-tooltip prop:content={props.tooltip ?? props.label}>
      <button
        type="button"
        class={["btn btn--icon btn--ghost refresh-button", props.class]}
        aria-label={props.label}
        aria-busy={props.busy ? "true" : undefined}
        disabled={props.busy || props.disabled}
        onClick={() => props.onClick()}
      >
        <Icon name="refresh" />
      </button>
    </openclaw-tooltip>
  );
}

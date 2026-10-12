import type { JSX } from "@solidjs/web";

export type PanelIconButtonProps = {
  label: string;
  icon: JSX.Element;
  onClick: () => void;
  class: string;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
  newTab?: boolean;
};

export function PanelIconButton(props: PanelIconButtonProps) {
  return (
    <button
      class={props.class}
      type="button"
      data-new-tab-action={props.newTab ? "" : undefined}
      title={props.title ?? props.label}
      aria-label={props.label}
      aria-busy={props.busy === undefined ? undefined : props.busy ? "true" : "false"}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      {props.icon}
    </button>
  );
}

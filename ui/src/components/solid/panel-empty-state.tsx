import type { JSX } from "@solidjs/web";
import "../../styles/panel-empty-state.css";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-panel-empty-state": HTMLAttributes<HTMLElement>;
    }
  }
}

export type PanelEmptyStateProps = {
  icon: JSX.Element;
  heading: string;
  description: string;
  action?: JSX.Element;
};

export function PanelEmptyStateContent(props: PanelEmptyStateProps) {
  return (
    <div class="empty-state" role="status">
      <div class="empty-state__icon" aria-hidden="true">
        {props.icon}
      </div>
      <strong class="empty-state__title">{props.heading}</strong>
      <p class="empty-state__description">{props.description}</p>
      {props.action != null ? <span slot="action">{props.action}</span> : undefined}
    </div>
  );
}

export function PanelEmptyState(props: PanelEmptyStateProps) {
  return (
    <openclaw-panel-empty-state>
      <PanelEmptyStateContent {...props} />
    </openclaw-panel-empty-state>
  );
}

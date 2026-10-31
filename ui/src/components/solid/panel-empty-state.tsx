import type { JSX } from "@solidjs/web";
import panelStyles from "../../styles/panel-empty-state.css?inline";

export function PanelEmptyState(props: {
  icon?: JSX.Element;
  heading: string;
  description: string;
  action?: JSX.Element;
  /** Explicit session presentation; omitted keeps existing consumers unchanged. */
  presentation?: "desktop" | "mobile";
}) {
  return (
    <openclaw-panel-empty-state>
      <style>{panelStyles}</style>
      <div class="empty-state" data-presentation={props.presentation} role="status">
        {(!props.presentation || props.icon) && (
          <div class="empty-state__icon" aria-hidden="true">
            {props.icon}
          </div>
        )}
        {props.action != null ? <span slot="action">{props.action}</span> : undefined}
        {(!props.presentation || props.heading || props.description) && (
          <div class="empty-state__body">
            {(!props.presentation || props.heading) && (
              <strong class="empty-state__title">{props.heading}</strong>
            )}
            {(!props.presentation || props.description) && (
              <p class="empty-state__description">{props.description}</p>
            )}
          </div>
        )}
      </div>
    </openclaw-panel-empty-state>
  );
}

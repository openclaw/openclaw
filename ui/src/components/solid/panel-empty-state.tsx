import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import panelStyles from "../../styles/panel-empty-state.css?inline";

export type PanelEmptyStateProps = {
  icon?: JSX.Element;
  heading: string;
  description: string;
  action?: JSX.Element;
};

export type PanelEmptyStateElement = SolidBridgeElement<PanelEmptyStateProps>;

export function PanelEmptyStateContent(props: PanelEmptyStateProps & { children?: JSX.Element }) {
  let outlet!: HTMLDivElement;
  // Keep the caller's Lit range intact; only its direct unnamed elements are decorative.
  onSettled(() => {
    const update = () => {
      for (const element of outlet.children) {
        if (element.getAttribute("slot") !== "action") {
          element.setAttribute("aria-hidden", "true");
        }
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(outlet, { childList: true });
    return () => observer.disconnect();
  });
  return (
    <div class="empty-state" role="status">
      <div
        class="empty-state__icon"
        ref={(element) => {
          outlet = element;
        }}
      >
        {props.children ?? (
          <>
            {props.icon}
            {props.action != null ? <span slot="action">{props.action}</span> : undefined}
          </>
        )}
      </div>
      <strong class="empty-state__title">{props.heading}</strong>
      <p class="empty-state__description">{props.description}</p>
    </div>
  );
}

export const PanelEmptyState = defineSolidBridge<PanelEmptyStateProps>(
  "openclaw-panel-empty-state",
  (props) => (
    <>
      <style>{panelStyles}</style>
      <PanelEmptyStateContent {...props} />
    </>
  ),
  {
    properties: {
      heading: { default: "" },
      description: { default: "" },
      icon: { default: undefined, attribute: false },
      action: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-empty-state": PanelEmptyStateElement;
  }
}

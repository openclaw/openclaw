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
  let outlet: HTMLDivElement | undefined;
  // Keep the caller's Lit range intact; only its direct unnamed elements are decorative.
  onSettled(() => {
    if (!outlet) {
      return undefined;
    }
    const content = outlet;
    const hidden = new Map<Element, string | null>();
    const restore = (element: Element, value: string | null) => {
      if (element.getAttribute("aria-hidden") === "true") {
        if (value === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", value);
        }
      }
    };
    const update = () => {
      for (const [element, value] of hidden) {
        if (element.parentElement !== content || element.getAttribute("slot") === "action") {
          restore(element, value);
          hidden.delete(element);
        }
      }
      for (const element of content.children) {
        if (element.getAttribute("slot") !== "action") {
          if (!hidden.has(element)) {
            hidden.set(element, element.getAttribute("aria-hidden"));
          }
          element.setAttribute("aria-hidden", "true");
        }
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(content, {
      childList: true,
      attributes: true,
      attributeFilter: ["slot"],
      subtree: true,
    });
    return () => {
      observer.disconnect();
      for (const [element, value] of hidden) {
        restore(element, value);
      }
    };
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

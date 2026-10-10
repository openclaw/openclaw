import { render as renderSolid } from "@solidjs/web";
import { nothing, render as renderLit, type TemplateResult } from "lit";
import { createComponent, createEffect, createMemo, getOwner, onCleanup } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { TooltipContents, type NativeTooltipHandle } from "./solid/tooltip.tsx";
import {
  TooltipProvider,
  consumeTooltipEscape,
  type TooltipPolicyProps,
} from "./tooltip-controller.ts";

export { consumeTooltipEscape };

export interface TooltipProps extends TooltipPolicyProps {
  contentTemplate?: TemplateResult;
}
export interface TooltipMethods {
  previewForAnchor(
    anchor: HTMLElement | SVGElement,
    content: string,
    input: "pointer" | "focus",
  ): void;
  focusTriggerWithoutOpening(target: HTMLElement): void;
}
export type TooltipElement = SolidBridgeElement<TooltipProps, TooltipMethods>;
const handles = new WeakMap<HTMLElement, NativeTooltipHandle>();

/** Opaque Lit presentation remains a leaf until the last template-valued caller ports. */
function TooltipTemplate(props: { template: TemplateResult | undefined }) {
  const leaf = document.createElement("span");
  createEffect(
    () => props.template,
    (template) => renderLit(template ?? nothing, leaf),
  );
  onCleanup(() => renderLit(nothing, leaf));
  return leaf;
}

export const Tooltip = defineSolidBridge<TooltipProps, TooltipMethods>(
  "openclaw-tooltip",
  (props, host) => {
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const template = createMemo(() =>
      props.contentTemplate === undefined
        ? undefined
        : createComponent(TooltipTemplate, {
            get template() {
              return props.contentTemplate;
            },
          }),
    );
    const dispose = renderSolid(
      () =>
        createComponent(TooltipContents, {
          host,
          get content() {
            return props.content;
          },
          get placement() {
            return props.placement;
          },
          get closeDelay() {
            return props.closeDelay;
          },
          get hoverDismissDelay() {
            return props.hoverDismissDelay;
          },
          get delay() {
            return props.delay;
          },
          get describe() {
            return props.describe;
          },
          get autoSize() {
            return props.autoSize;
          },
          get disabled() {
            return props.disabled;
          },
          get openOnClick() {
            return props.openOnClick;
          },
          get anchor() {
            return props.anchor;
          },
          get contentTemplate() {
            return template();
          },
          preview: (anchor, content) => {
            host.anchor = anchor;
            host.content = content;
          },
          expose: (handle) => {
            if (handle) {
              handles.set(host, handle);
            } else {
              handles.delete(host);
            }
          },
        }),
      root,
      undefined,
      { owner: getOwner() },
    );
    onCleanup(dispose);
    // The caller's Lit parts retain one intact range, including all slot attributes.
    return props.children;
  },
  {
    properties: {
      content: { default: "" },
      contentTemplate: { default: undefined, attribute: false },
      placement: { default: "top" },
      closeDelay: { default: 100, type: Number },
      hoverDismissDelay: { default: undefined, type: Number },
      delay: { default: undefined, type: Number },
      describe: { default: true, type: Boolean },
      autoSize: { default: false, attribute: "auto-size", type: Boolean },
      disabled: { default: false, type: Boolean },
      openOnClick: { default: false, attribute: "open-on-click", type: Boolean },
      anchor: { default: null, attribute: false },
    },
    methods: {
      previewForAnchor: (host, anchor, content, input) => {
        host.anchor = anchor;
        host.content = content;
        void host.updateComplete.then(() => {
          if (
            host.isConnected &&
            anchor.isConnected &&
            host.anchor === anchor &&
            host.content === content
          ) {
            handles.get(host)?.controller.previewForAnchor(anchor, content, input);
          }
        });
      },
      focusTriggerWithoutOpening: (host, target) => {
        const handle = handles.get(host);
        if (handle) {
          handle.controller.focusTriggerWithoutOpening(target);
        } else {
          target.focus();
        }
      },
    },
    connected: (host) => handles.get(host)?.connected(),
    disconnected: (host) => handles.get(host)?.disconnected(),
  },
);

export function focusWithoutTooltip(target: HTMLElement | null | undefined) {
  const tooltip = target?.closest<TooltipElement>("openclaw-tooltip");
  if (tooltip && target) {
    tooltip.focusTriggerWithoutOpening(target);
  } else {
    target?.focus();
  }
}

if (!customElements.get("openclaw-tooltip-provider")) {
  customElements.define("openclaw-tooltip-provider", TooltipProvider);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-tooltip-provider": TooltipProvider;
    "openclaw-tooltip": TooltipElement;
  }
}

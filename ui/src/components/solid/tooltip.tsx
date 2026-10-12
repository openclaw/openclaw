import { render } from "@solidjs/web";
import type { JSX } from "@solidjs/web";
import { Show, createSignal, flush } from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import { createOverlayAnchor } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../overlay-lifecycle.ts";
import type { TooltipController } from "../tooltip-controller.ts";
import { TooltipElement, type TooltipProps, type TooltipRuntime } from "../tooltip.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import tooltipStyles from "./tooltip.css?inline";

export type { TooltipElement } from "../tooltip.ts";

/** The native tag owns policy and slots; Solid owns only its lazily loaded text content. */
export function mountTooltipView(
  host: TooltipElement,
  surface: HTMLDivElement,
  rich: HTMLSpanElement,
  policy: TooltipController,
): TooltipRuntime {
  const content = host.ownerDocument.createElement("span");
  content.className = "tooltip-content";
  surface.insertBefore(content, rich);
  let updateContent = () => {};
  const disposeContent = render(() => {
    const [revision, setRevision] = createSignal(0);
    updateContent = () => setRevision((value) => value + 1);
    const template = () => {
      revision();
      return host.contentTemplate;
    };
    const text = () => {
      revision();
      return host.content;
    };
    return (
      <Show when={template()} fallback={text()}>
        {(value) => <LitContent value={value()} />}
      </Show>
    );
  }, content);
  let anchorBinding: ReturnType<typeof createOverlayAnchor> | undefined;
  let anchoredTrigger: HTMLElement | SVGElement | null = null;
  let anchoredPlacement: string | undefined;
  const overlay = createOverlay("tooltip", undefined, {
    exclusiveGroup: "tooltip",
    dismissOutsidePointer: false,
    dismissOutsideFocus: false,
    dismissEscape: false,
    reflectTriggerExpanded: false,
    isValid: () => !host.disabled && Boolean(policy.trigger?.isConnected),
    acquireOcclusion: acquireNativeOverlaySurface,
    onInteraction: (event, target) => policy.handleInteraction(event, target),
    interactionElements: () => (policy.trigger ? [policy.trigger] : []),
    onRootChange: (root) =>
      root === host.shadowRoot
        ? retainShadowStyles(root, [overlayStyles, tooltipStyles])
        : undefined,
  });
  overlay.bindSurface(surface);
  overlay.setParent(findOverlayParent(policy.trigger ?? host));
  const unsubscribe = overlay.subscribe((open) => policy.acceptedOpen(open));
  const events = [
    ["overlay-show", "wa-show"],
    ["overlay-hide", "wa-hide"],
    ["overlay-after-show", "wa-after-show"],
    ["overlay-after-hide", "wa-after-hide"],
  ] as const;
  const listeners = events.map(([source, target]) => {
    const listener = (event: Event) => {
      if (event.target !== surface) {
        return;
      }
      event.stopPropagation();
      if (
        !host.dispatchEvent(
          new CustomEvent(target, { bubbles: true, composed: true, cancelable: event.cancelable }),
        )
      ) {
        event.preventDefault();
      }
    };
    surface.addEventListener(source, listener);
    return () => surface.removeEventListener(source, listener);
  });
  const updateAnchor = () => {
    const trigger = policy.trigger;
    if (!trigger) {
      return;
    }
    const placement = policy.resolvedPlacement;
    if (trigger !== anchoredTrigger || placement !== anchoredPlacement) {
      anchorBinding ??= createOverlayAnchor(surface);
      anchorBinding.update(trigger, placement);
      anchoredTrigger = trigger;
      anchoredPlacement = placement;
    }
    surface.setAttribute("placement", placement);
  };
  return {
    request(open) {
      const trigger = policy.trigger;
      if (open && trigger) {
        overlay.setParent(findOverlayParent(trigger));
      }
      overlay.bindTrigger(trigger instanceof HTMLElement ? trigger : undefined);
      updateAnchor();
      return overlay.request(open);
    },
    update() {
      updateContent();
      flush();
      if (overlay.open) {
        updateAnchor();
      }
    },
    retire: () => overlay.retire(),
    dispose() {
      unsubscribe();
      overlay.dispose();
      anchorBinding?.dispose();
      disposeContent();
      content.remove();
      for (const remove of listeners) {
        remove();
      }
    },
  };
}

type ComponentProps = TooltipProps & Omit<JSX.HTMLAttributes<TooltipElement>, keyof TooltipProps>;

/** Solid callers use the same native tag without pulling presentation into startup. */
export const Tooltip = Object.assign(
  function Tooltip(props: ComponentProps) {
    return (
      <openclaw-tooltip
        {...props}
        prop:content={props.content ?? ""}
        prop:contentTemplate={props.contentTemplate}
        prop:placement={props.placement ?? "top"}
        prop:closeDelay={props.closeDelay ?? 100}
        prop:hoverDismissDelay={props.hoverDismissDelay}
        prop:delay={props.delay}
        prop:describe={props.describe ?? true}
        prop:autoSize={props.autoSize ?? false}
        prop:disabled={props.disabled ?? false}
        prop:openOnClick={props.openOnClick ?? false}
        prop:anchor={props.anchor ?? null}
      />
    );
  },
  { Element: TooltipElement },
);

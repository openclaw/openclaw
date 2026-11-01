import type { JSX } from "@solidjs/web";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createOverlayAnchor } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../overlay-lifecycle.ts";
import type { TooltipOwner, TooltipPolicyProps } from "../tooltip-owner.ts";
import { TooltipElement, type TooltipRuntime } from "../tooltip.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import kbdStyles from "../kbd.css?inline";
import overlayStyles from "./overlay.css?inline";
import tooltipStyles from "./tooltip.css?inline";

export type { TooltipElement } from "../tooltip.ts";

/** Policy and slots stay on the native tag; presentation loads only on reveal. */
export function mountTooltipView(
  host: TooltipElement,
  surface: HTMLDivElement,
  rich: HTMLSpanElement,
  policy: TooltipOwner,
): TooltipRuntime {
  const content = host.ownerDocument.createElement("span");
  content.className = "tooltip-content";
  surface.insertBefore(content, rich);
  content.textContent = host.content;
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
        ? retainShadowStyles(root, [overlayStyles, tooltipStyles, kbdStyles])
        : undefined,
  });
  overlay.bindSurface(surface);
  overlay.setParent(findOverlayParent(policy.trigger ?? host));
  // Apply accepted-open policy synchronously; only completion events need forwarding.
  const unsubscribe = overlay.subscribe((open) => policy.acceptedOpen(open));
  const listeners = ["overlay-after-show", "overlay-after-hide"].map((type) => {
    const listener = (event: Event) => {
      if (event.target !== surface) {
        return;
      }
      event.stopPropagation();
      if (
        !host.dispatchEvent(
          new CustomEvent(type, { bubbles: true, composed: true, cancelable: event.cancelable }),
        )
      ) {
        event.preventDefault();
      }
    };
    return listen(surface, type, listener);
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
      content.textContent = host.content;
      if (overlay.open) {
        updateAnchor();
      }
    },
    retire: () => overlay.retire(),
    dispose() {
      unsubscribe();
      overlay.dispose();
      anchorBinding?.dispose();
      content.remove();
      for (const remove of listeners) {
        remove();
      }
    },
  };
}

type ComponentProps = TooltipPolicyProps &
  Omit<JSX.HTMLAttributes<TooltipElement>, keyof TooltipPolicyProps>;

/** Solid callers use the same native tag without pulling presentation into startup. */
export const Tooltip = Object.assign(
  function Tooltip(props: ComponentProps) {
    return (
      <openclaw-tooltip
        {...props}
        prop:content={props.content ?? ""}
        prop:placement={props.placement}
        prop:closeDelay={props.closeDelay ?? 100}
        prop:hoverDismissDelay={props.hoverDismissDelay}
        prop:delay={props.delay}
        prop:describe={props.describe ?? true}
        prop:descriptionTarget={props.descriptionTarget}
        prop:pointerThrough={props.pointerThrough ?? false}
        prop:autoSize={props.autoSize ?? false}
        prop:disabled={props.disabled ?? false}
        prop:openOnClick={props.openOnClick ?? false}
        prop:anchor={props.anchor ?? null}
      />
    );
  },
  { Element: TooltipElement },
);

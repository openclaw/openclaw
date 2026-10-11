import type { JSX as SolidJSX } from "@solidjs/web";
import { Show, createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createOverlayAnchor } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../overlay-lifecycle.ts";
import { isTooltipTriggerElement } from "../tooltip-content.ts";
import { TooltipController, type TooltipPolicyProps } from "../tooltip-controller.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import tooltipStyles from "./tooltip.css?inline";

export function TooltipChildren(props: { children?: SolidJSX.Element }) {
  return <>{props.children}</>;
}

export interface TooltipContentsProps extends TooltipPolicyProps {
  host: HTMLElement;
  contentTemplate?: SolidJSX.Element;
  expose?: (handle: NativeTooltipHandle | undefined) => void;
  preview: (anchor: HTMLElement | SVGElement, content: string) => void;
}

export interface NativeTooltipHandle {
  controller: TooltipController;
  connected(): void;
  disconnected(): void;
}

/** The bridge and Solid host share this renderer; policy stays synchronous and renderer-neutral. */
export function TooltipContents(props: TooltipContentsProps) {
  let surface!: HTMLDivElement;
  let rich!: HTMLSpanElement;
  let triggerSlot!: HTMLSlotElement;
  let contentSlot!: HTMLSlotElement;
  const readPolicyProps = (): TooltipPolicyProps => ({
    content: props.content,
    placement: props.placement,
    closeDelay: props.closeDelay,
    hoverDismissDelay: props.hoverDismissDelay,
    delay: props.delay,
    describe: props.describe,
    autoSize: props.autoSize,
    disabled: props.disabled,
    openOnClick: props.openOnClick,
    anchor: props.anchor,
  });
  let currentProps = untrack(readPolicyProps);
  let controller: TooltipController | undefined;
  let anchorBinding: ReturnType<typeof createOverlayAnchor> | undefined;
  let anchoredTrigger: HTMLElement | SVGElement | null = null;
  let anchoredPlacement: string | undefined;
  const [materialized, setMaterialized] = createSignal(false);
  const overlay = createOverlay("tooltip", undefined, {
    exclusiveGroup: "tooltip",
    dismissOutsidePointer: false,
    dismissOutsideFocus: false,
    dismissEscape: false,
    reflectTriggerExpanded: false,
    isValid: () => !currentProps.disabled && Boolean(controller?.trigger?.isConnected),
    acquireOcclusion: acquireNativeOverlaySurface,
    onInteraction: (event, target) => controller?.handleInteraction(event, target),
    interactionElements: () => (controller?.trigger ? [controller.trigger] : []),
    onRootChange: (root) =>
      root === props.host.shadowRoot
        ? retainShadowStyles(root, [overlayStyles, tooltipStyles])
        : undefined,
  });

  const forward = (source: Event, name: string) => {
    if (source.target !== surface) {
      return;
    }
    source.stopPropagation();
    if (
      !props.host.dispatchEvent(
        new CustomEvent(name, { bubbles: true, composed: true, cancelable: source.cancelable }),
      )
    ) {
      source.preventDefault();
    }
  };

  const updateAnchor = () => {
    const trigger = controller?.trigger;
    if (!trigger || !controller) {
      return;
    }
    const placement = controller.resolvedPlacement;
    if (trigger !== anchoredTrigger || placement !== anchoredPlacement) {
      anchorBinding ??= createOverlayAnchor(surface);
      anchorBinding.update(trigger, placement);
      anchoredTrigger = trigger;
      anchoredPlacement = placement;
    }
    surface.setAttribute("placement", placement);
  };

  onSettled(() => {
    const readTrigger = () => {
      const element = triggerSlot.assignedElements({ flatten: true }).find(isTooltipTriggerElement);
      return isTooltipTriggerElement(element) ? element : null;
    };
    const policy = new TooltipController(props.host, {
      props: () => currentProps,
      trigger: readTrigger,
      richContent: () => contentSlot.assignedNodes({ flatten: true }),
      richContainer: () => rich,
      preview: (anchor, content) => props.preview(anchor, content),
      retire: () => overlay.retire(),
      requestOpen: (open) => {
        const trigger = policy.trigger;
        if (open && trigger) {
          overlay.setParent(findOverlayParent(trigger));
        }
        overlay.bindTrigger(trigger instanceof HTMLElement ? trigger : undefined);
        updateAnchor();
        return overlay.request(open);
      },
    });
    controller = policy;
    surface.id = policy.id;
    overlay.bindSurface(surface);
    const unsubscribe = overlay.subscribe((open) => {
      if (open) {
        setMaterialized(true);
      }
      policy.acceptedOpen(open);
    });
    const events = [
      ["overlay-show", "wa-show"],
      ["overlay-hide", "wa-hide"],
      ["overlay-after-show", "wa-after-show"],
      ["overlay-after-hide", "wa-after-hide"],
    ] as const;
    const listeners = events.map(([source, target]) => {
      const listener = (event: Event) => forward(event, target);
      surface.addEventListener(source, listener);
      return () => surface.removeEventListener(source, listener);
    });
    policy.refresh();
    const childObserver = new MutationObserver(() => {
      if (!currentProps.anchor && readTrigger() !== policy.trigger) {
        policy.refresh();
      }
    });
    childObserver.observe(props.host, { childList: true });
    props.expose?.({
      controller: policy,
      connected: () => {
        policy.refresh();
        overlay.request(overlay.open);
      },
      disconnected: () => overlay.retire(),
    });
    return () => {
      props.expose?.(undefined);
      childObserver.disconnect();
      unsubscribe();
      overlay.dispose();
      anchorBinding?.dispose();
      policy.dispose();
      for (const remove of listeners) {
        remove();
      }
      controller = undefined;
    };
  });

  createEffect(readPolicyProps, (next) => {
    currentProps = next;
    controller?.refresh();
    if (overlay.open) {
      updateAnchor();
    }
  });
  onCleanup(() => overlay.dispose());

  return (
    <>
      <slot
        ref={(element) => {
          triggerSlot = element;
        }}
        onSlotChange={() => controller?.refresh()}
      />
      <div
        ref={(element) => {
          surface = element;
        }}
        class="oc-overlay tooltip-surface"
        popover="manual"
        role="tooltip"
      >
        <Show when={materialized()}>
          <span class="tooltip-content">{props.contentTemplate ?? props.content}</span>
        </Show>
        <span
          ref={(element) => {
            rich = element;
          }}
          class="tooltip-rich-content"
          inert
          onPointerEnter={(event) => controller?.handleContentPointerEnter(event)}
          onPointerLeave={(event) => controller?.handleContentPointerLeave(event)}
          onFocusIn={() => controller?.handleFocusIn()}
          onFocusOut={(event) => controller?.handleFocusOut(event)}
        >
          <slot
            name="content"
            ref={(element) => {
              contentSlot = element;
            }}
            onSlotChange={() => controller?.contentChanged()}
          />
        </span>
      </div>
    </>
  );
}

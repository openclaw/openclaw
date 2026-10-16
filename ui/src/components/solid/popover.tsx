import type { JSX } from "@solidjs/web";
import { Show, createEffect, onSettled, untrack } from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createOverlayAnchor, type OverlayPlacement } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent, type Overlay } from "../overlay-lifecycle.ts";
import { useOverlayControl } from "./overlay-control.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import "./overlay.css";

export interface PopoverHandle {
  readonly overlay: Overlay;
  show(): boolean;
  hide(): boolean;
}

export interface PopoverProps {
  /** Preserve drafts by default; transient bodies are released after the exit. */
  lazy?: boolean | "while-open";
  /** The caller keeps anchor and surface in one DOM root for this mount. */
  sameRoot?: boolean;
  id: string;
  label: string;
  anchor?: HTMLElement;
  trigger?: JSX.Element;
  children?: JSX.Element;
  class?: JSX.HTMLAttributes<HTMLDivElement>["class"];
  open?: boolean;
  placement?: OverlayPlacement;
  dismissOutsidePointer?: boolean;
  dismissOutsideFocus?: boolean;
  onBeforeShow?(event: Event): void;
  onBeforeHide?(event: Event): void;
  onOpenChange?(open: boolean): void;
  ref?(handle: PopoverHandle): void;
}

export function Popover(props: PopoverProps): JSX.Element {
  let trigger!: HTMLButtonElement;
  let surface!: HTMLDivElement;
  let mounted = false;
  let anchorBinding: ReturnType<typeof createOverlayAnchor> | undefined;
  // Identity, lazy mounting, and root placement are fixed for this native overlay lifetime.
  const id = untrack(() => props.id);
  const lazy = untrack(() => props.lazy);
  const sameRoot = untrack(() => props.sameRoot ?? false);
  const overlay = createOverlay(id, undefined, {
    get dismissOutsidePointer() {
      return props.dismissOutsidePointer;
    },
    get dismissOutsideFocus() {
      return props.dismissOutsideFocus;
    },
    acquireOcclusion: acquireNativeOverlaySurface,
    onRootChange: (root) =>
      root instanceof ShadowRoot ? retainShadowStyles(root, [overlayStyles]) : undefined,
  });
  const control = useOverlayControl(overlay, props, () => props.children);
  createEffect(
    () => [props.anchor, props.placement] as const,
    ([anchor, placement]) => {
      if (!mounted) {
        return;
      }
      const target = anchor ?? trigger;
      overlay.bindTrigger(target);
      overlay.setParent(findOverlayParent(target));
      anchorBinding?.update(target, placement);
    },
  );
  onSettled(() => {
    overlay.bindSurface(surface);
    mounted = true;
    const target = props.anchor ?? trigger;
    overlay.bindTrigger(target);
    overlay.setParent(findOverlayParent(target));
    anchorBinding = createOverlayAnchor(overlay.surface, { sameRoot });
    anchorBinding.update(target, props.placement);
    const disconnectControl = control.connect(() =>
      props.ref?.({
        overlay,
        show: () => overlay.request(true),
        hide: () => overlay.request(false),
      }),
    );
    return () => {
      mounted = false;
      anchorBinding?.dispose();
      disconnectControl();
    };
  });
  return (
    <>
      <Show when={!props.anchor}>
        <button
          ref={(node) => {
            trigger = node;
          }}
          type="button"
          aria-label={props.label}
          aria-haspopup="dialog"
          aria-controls={id}
          onClick={() => overlay.request(!overlay.open)}
        >
          {props.trigger ?? props.label}
        </button>
      </Show>
      <div
        ref={(node) => {
          surface = node;
        }}
        class={["oc-overlay oc-popover", props.class]}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={props.label}
        tabindex={-1}
      >
        {lazy ? undefined : props.children}
      </div>
    </>
  );
}

import { dynamic, type JSX } from "@solidjs/web";
import { Show, onSettled, untrack } from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createAnchoredOverlay } from "../../lib/reactive/overlay-anchor.ts";
import { showOverlayAnchor, type OverlayPlacement } from "../overlay-anchor.ts";
import { createOverlay, type Overlay } from "../overlay-lifecycle.ts";
import { useOverlayControl } from "./overlay-control.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import "./overlay.css";

export interface PopoverHandle {
  readonly overlay: Overlay;
  show(): boolean;
  hide(): boolean;
}

export function Popover(props: {
  /** Keep an attached surface in its parent stacking context. */
  contained?: boolean;
  /** Preserve drafts by default; transient bodies are released after the exit. */
  lazy?: boolean | "while-open";
  /** The caller keeps anchor and surface in one DOM root for this mount. */
  sameRoot?: boolean;
  id: string;
  label: string;
  anchor?: HTMLElement;
  /** Geometry only; the trigger retains activation, dismissal, and focus ownership. */
  positionAnchor?: HTMLElement;
  trigger?: JSX.Element;
  triggerId?: string;
  triggerClass?: JSX.HTMLAttributes<HTMLButtonElement>["class"];
  triggerTitle?: string;
  triggerAriaLabel?: string | null;
  children?: JSX.Element;
  class?: JSX.HTMLAttributes<HTMLDivElement>["class"];
  open?: boolean;
  disabled?: boolean;
  placement?: OverlayPlacement;
  dismissOutsidePointer?: boolean;
  dismissOutsideFocus?: boolean;
  onBeforeShow?(event: Event): void;
  onBeforeHide?(event: Event): void;
  onOpenChange?(open: boolean): void;
  ref?(handle: PopoverHandle): void;
}): JSX.Element {
  let trigger!: HTMLButtonElement;
  let surface!: HTMLDivElement | HTMLDialogElement;
  // Identity, lazy mounting, and root placement are fixed for this native overlay lifetime.
  const initialIdentity = untrack(() => ({
    id: props.id,
    lazy: props.lazy,
    sameRoot: props.sameRoot ?? false,
    contained: props.contained ?? false,
  }));
  const Surface = dynamic(() => (initialIdentity.contained ? "dialog" : "div"));
  const overlay = createOverlay(initialIdentity.id, undefined, {
    get dismissOutsidePointer() {
      return props.dismissOutsidePointer;
    },
    get dismissOutsideFocus() {
      return props.dismissOutsideFocus;
    },
    native: initialIdentity.contained
      ? {
          isOpen: (node) => node.hasAttribute("open"),
          show: (node) => {
            showOverlayAnchor(node);
            if (node instanceof HTMLDialogElement) {
              node.show();
            }
          },
          hide: (node) => {
            if (node instanceof HTMLDialogElement) {
              node.close();
            }
          },
        }
      : undefined,
    acquireOcclusion: acquireNativeOverlaySurface,
    onRootChange: (root) =>
      root instanceof ShadowRoot ? retainShadowStyles(root, [overlayStyles]) : undefined,
  });
  const control = useOverlayControl(overlay, initialIdentity.lazy, props, () => props.children);
  const anchor = createAnchoredOverlay(
    overlay,
    () => trigger,
    () => ({
      anchor: props.anchor,
      positionAnchor: props.positionAnchor,
      placement: props.placement,
    }),
    { sameRoot: initialIdentity.sameRoot, lazy: Boolean(initialIdentity.lazy) },
  );
  onSettled(() => {
    overlay.bindSurface(surface);
    const disconnectAnchor = anchor.connect();
    const disconnectControl = control.connect(() =>
      props.ref?.({
        overlay,
        show: () => overlay.request(true),
        hide: () => overlay.request(false),
      }),
    );
    return () => {
      disconnectAnchor();
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
          id={props.triggerId}
          class={props.triggerClass}
          title={props.triggerTitle}
          disabled={props.disabled}
          aria-label={
            props.triggerAriaLabel === null ? undefined : (props.triggerAriaLabel ?? props.label)
          }
          aria-haspopup="dialog"
          aria-controls={initialIdentity.id}
          aria-expanded="false"
          onClick={() => overlay.request(!overlay.open)}
        >
          {props.trigger ?? props.label}
        </button>
      </Show>
      <Surface
        ref={(node: HTMLDivElement | HTMLDialogElement) => {
          surface = node;
        }}
        class={["oc-overlay oc-popover", props.class]}
        id={initialIdentity.id}
        popover={initialIdentity.contained ? undefined : "manual"}
        role="dialog"
        aria-label={props.label}
        tabindex={-1}
      >
        {initialIdentity.lazy ? undefined : props.children}
      </Surface>
    </>
  );
}

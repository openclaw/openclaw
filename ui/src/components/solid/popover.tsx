import type { JSX } from "@solidjs/web";
import { Show, createEffect, onCleanup, onSettled, untrack } from "solid-js";
import { acquireNativeOverlaySurface } from "../../lib/native-overlay-occlusion.ts";
import { createOverlayAnchor, type OverlayPlacement } from "../overlay-anchor.ts";
import { createOverlay, findOverlayParent, type Overlay } from "../overlay-lifecycle.ts";
import { retainShadowStyles } from "./shadow-styles.ts";
import overlayStyles from "./overlay.css?inline";
import "./overlay.css";

export interface PopoverHandle {
  readonly overlay: Overlay;
  show(): boolean;
  hide(): boolean;
}

export interface PopoverProps {
  id: string;
  label: string;
  anchor?: HTMLElement;
  trigger?: JSX.Element;
  children?: JSX.Element;
  class?: string;
  open?: boolean;
  placement?: OverlayPlacement;
  onBeforeShow?(event: Event): void;
  onBeforeHide?(event: Event): void;
  onOpenChange?(open: boolean): void;
  ref?(handle: PopoverHandle): void;
}

export function Popover(props: PopoverProps): JSX.Element {
  let trigger!: HTMLButtonElement;
  let surface!: HTMLDivElement;
  let mounted = false;
  let publications = 0;
  let anchorBinding: ReturnType<typeof createOverlayAnchor> | undefined;
  const id = untrack(() => props.id);
  const overlay = createOverlay(id, undefined, {
    acquireOcclusion: acquireNativeOverlaySurface,
    onRootChange: (root) =>
      root instanceof ShadowRoot ? retainShadowStyles(root, [overlayStyles]) : undefined,
  });
  const syncOpen = (open: boolean) => {
    if (open === overlay.open) {
      return;
    }
    const before = publications;
    if (!overlay.request(open) && publications === before) {
      untrack(() => props.onOpenChange?.(overlay.open));
    }
  };
  onCleanup(() => overlay.dispose());
  createEffect(
    () => props.open,
    (open) => {
      if (mounted && open !== undefined) {
        syncOpen(open);
      }
    },
  );
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
    anchorBinding = createOverlayAnchor(overlay.surface);
    anchorBinding.update(target, props.placement);
    const stopOpen = overlay.subscribe((open) => {
      publications += 1;
      untrack(() => props.onOpenChange?.(open));
    });
    const show = (event: Event) => {
      if (event.target === overlay.surface) {
        props.onBeforeShow?.(event);
      }
    };
    const hide = (event: Event) => {
      if (event.target === overlay.surface) {
        props.onBeforeHide?.(event);
      }
    };
    overlay.surface.addEventListener("overlay-show", show);
    overlay.surface.addEventListener("overlay-hide", hide);
    props.ref?.({ overlay, show: () => overlay.request(true), hide: () => overlay.request(false) });
    if (props.open) {
      syncOpen(true);
    }
    return () => {
      mounted = false;
      anchorBinding?.dispose();
      stopOpen();
      overlay.surface.removeEventListener("overlay-show", show);
      overlay.surface.removeEventListener("overlay-hide", hide);
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
        {props.children}
      </div>
    </>
  );
}

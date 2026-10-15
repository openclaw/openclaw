import { createEffect, onCleanup, untrack } from "solid-js";
import type { Overlay } from "../overlay-lifecycle.ts";

type OverlayControlProps = {
  open?: boolean;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
  onBeforeShow?(event: Event): void;
  onBeforeHide?(event: Event): void;
};

/** Controlled values and veto callbacks share the native overlay's accepted-open authority. */
export function useOverlayControl(overlay: Overlay, props: OverlayControlProps) {
  let mounted = false;
  const syncOpen = (open: boolean) => {
    if (open === overlay.open) {
      return;
    }
    if (!overlay.request(open)) {
      untrack(() => props.onOpenChange?.(overlay.open));
    }
  };
  createEffect(
    () => props.open,
    (open) => {
      if (mounted && open !== undefined) {
        syncOpen(open);
      }
    },
  );
  onCleanup(() => overlay.dispose());
  return (onConnect: () => void, onOpen?: (open: boolean) => void) => {
    mounted = true;
    const stopOpen = overlay.subscribe((open) => {
      onOpen?.(open);
      untrack(() => props.onOpenChange?.(open));
    });
    const show = (event: Event) => {
      if (event.target === overlay.surface) {
        if (props.disabled) {
          event.preventDefault();
        }
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
    onConnect();
    if (props.open) {
      syncOpen(true);
    }
    return () => {
      mounted = false;
      stopOpen();
      overlay.surface.removeEventListener("overlay-show", show);
      overlay.surface.removeEventListener("overlay-hide", hide);
    };
  };
}

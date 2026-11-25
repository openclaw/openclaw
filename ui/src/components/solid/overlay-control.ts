import { insert, type JSX } from "@solidjs/web";
import { createEffect, createRoot, getOwner, onCleanup, runWithOwner } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import type { Overlay } from "../overlay-lifecycle.ts";

/** Controlled values and veto callbacks share the native overlay's accepted-open authority. */
export function useOverlayControl(
  overlay: Overlay,
  initialLazy: boolean | "while-open" | undefined,
  props: {
    open?: boolean;
    disabled?: boolean;
    onOpenChange?(open: boolean): void;
    onBeforeShow?(event: Event): void;
    onBeforeHide?(event: Event): void;
  },
  renderBody?: () => JSX.Element,
) {
  const owner = getOwner();
  let disposeBody: (() => void) | undefined;
  const clearBody = () => {
    if (disposeBody) {
      disposeBody();
      disposeBody = undefined;
      overlay.surface.replaceChildren();
    }
  };
  let mounted = false;
  const syncOpen = (open: boolean) => {
    if (open === overlay.open) {
      return;
    }
    if (!overlay.request(open)) {
      props.onOpenChange?.(overlay.open);
    }
  };
  createEffect(
    () => (props.disabled ? false : props.open),
    (open) => {
      if (mounted && open !== undefined) {
        syncOpen(open);
      }
    },
  );
  onCleanup(() => overlay.dispose());
  const connect = (onConnect: () => void, onOpen?: (open: boolean) => void) => {
    mounted = true;
    // Deliver each accepted transition to policy callbacks before publishing onOpenChange.
    const stopOpen = overlay.subscribe((open) => {
      onOpen?.(open);
      props.onOpenChange?.(open);
    });
    const stopShow = listen(overlay.surface, "overlay-show", (event: Event) => {
      if (event.target === overlay.surface) {
        if (props.disabled) {
          event.preventDefault();
        }
        if (initialLazy && renderBody && !disposeBody && !event.defaultPrevented) {
          // Admission and initial keyboard focus need the body synchronously.
          runWithOwner(owner, () => {
            disposeBody = createRoot((dispose) => {
              insert(overlay.surface, renderBody());
              return dispose;
            });
          });
          queueMicrotask(() => {
            if (!overlay.open && initialLazy === "while-open") {
              clearBody();
            }
          });
        }
        props.onBeforeShow?.(event);
      }
    });
    const stopHide = listen(overlay.surface, "overlay-hide", (event: Event) => {
      if (event.target === overlay.surface) {
        props.onBeforeHide?.(event);
      }
    });
    const stopHidden =
      initialLazy === "while-open"
        ? listen(overlay.surface, "overlay-after-hide", () => {
            if (!overlay.open) {
              clearBody();
            }
          })
        : undefined;
    const disconnect = () => {
      mounted = false;
      stopOpen();
      stopShow();
      stopHide();
      stopHidden?.();
      clearBody();
    };
    try {
      onConnect();
      if (props.open) {
        syncOpen(true);
      }
    } catch (error) {
      disconnect();
      throw error;
    }
    return disconnect;
  };
  return { connect, bodyMounted: () => Boolean(disposeBody) };
}

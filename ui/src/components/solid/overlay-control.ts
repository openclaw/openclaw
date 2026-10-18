import { insert, type JSX } from "@solidjs/web";
import { createEffect, createRoot, getOwner, onCleanup, runWithOwner } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import type { Overlay } from "../overlay-lifecycle.ts";

type OverlayControlProps = {
  open?: boolean;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
  onBeforeShow?(event: Event): void;
  onBeforeHide?(event: Event): void;
};

/** Controlled values and veto callbacks share the native overlay's accepted-open authority. */
export function useOverlayControl(
  overlay: Overlay,
  initialLazy: boolean | "while-open" | undefined,
  props: OverlayControlProps,
  renderBody?: () => JSX.Element,
) {
  const owner = getOwner();
  let disposeBody: (() => void) | undefined;
  const mountBody = () => {
    if (initialLazy && renderBody && !disposeBody) {
      runWithOwner(owner, () => {
        disposeBody = createRoot((dispose) => {
          insert(overlay.surface, renderBody());
          return dispose;
        });
      });
    }
  };
  const clearBody = () => {
    if (disposeBody) {
      disposeBody();
      disposeBody = undefined;
      overlay.surface.replaceChildren();
    }
  };
  onCleanup(clearBody);
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
    const stopOpen = overlay.subscribe((open) => {
      onOpen?.(open);
      props.onOpenChange?.(open);
    });
    const show = (event: Event) => {
      if (event.target === overlay.surface) {
        if (props.disabled) {
          event.preventDefault();
        }
        if (initialLazy && renderBody && !disposeBody && !event.defaultPrevented) {
          // Admission and initial keyboard focus need the body synchronously.
          mountBody();
          queueMicrotask(() => {
            if (!overlay.open && initialLazy === "while-open") {
              clearBody();
            }
          });
        }
        props.onBeforeShow?.(event);
      }
    };
    const hide = (event: Event) => {
      if (event.target === overlay.surface) {
        props.onBeforeHide?.(event);
      }
    };
    const stopShow = listen(overlay.surface, "overlay-show", show);
    const stopHide = listen(overlay.surface, "overlay-hide", hide);
    const stopHidden =
      initialLazy === "while-open"
        ? listen(overlay.surface, "overlay-after-hide", () => {
            if (!overlay.open) {
              clearBody();
            }
          })
        : undefined;
    onConnect();
    if (props.open) {
      syncOpen(true);
    }
    return () => {
      mounted = false;
      stopOpen();
      stopShow();
      stopHide();
      stopHidden?.();
    };
  };
  return { connect, mountBody, bodyMounted: () => Boolean(disposeBody) };
}

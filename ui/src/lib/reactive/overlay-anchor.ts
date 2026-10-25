import { createEffect } from "solid-js";
import {
  createOverlayAnchor,
  type OverlayAnchorBinding,
  type OverlayPlacement,
} from "../../components/overlay-anchor.ts";
import { findOverlayParent, type Overlay } from "../../components/overlay-lifecycle.ts";
import { listen } from "./listener.ts";

type Placement = OverlayPlacement | (() => OverlayPlacement);
type AnchorTarget = { anchor?: HTMLElement; placement?: Placement };

/** Own one anchor binding; pausing reactive updates retains its geometry and explicit updater. */
export function createAnchoredOverlay(
  overlay: Overlay,
  trigger: () => HTMLElement,
  target: () => AnchorTarget,
  options: {
    sameRoot?: boolean;
    anchored?: boolean;
    lazy?: boolean;
    paused?: () => boolean;
    parent?: Overlay;
  } = {},
) {
  let binding: OverlayAnchorBinding | undefined;
  const bindTrigger = (anchor: HTMLElement) => {
    overlay.bindTrigger(anchor);
    overlay.setParent(options.parent ?? findOverlayParent(anchor));
  };
  // Direction-dependent placement reads committed DOM, never the effect's compute phase.
  const update = (anchor: HTMLElement, placement?: Placement) =>
    binding?.update(anchor, typeof placement === "function" ? placement() : placement);
  createEffect(target, ({ anchor, placement }) => {
    if (binding && !options.paused?.()) {
      // Conditional trigger refs are assigned after the tracked input is prepared.
      const current = anchor ?? trigger();
      bindTrigger(current);
      update(current, placement);
    }
  });
  return {
    update,
    // The caller binds its surface first and preserves its control teardown order.
    connect() {
      const { anchor: initialAnchor, placement: initialPlacement } = target();
      const current = initialAnchor ?? trigger();
      bindTrigger(current);
      let stopShow: (() => void) | undefined;
      if (options.anchored !== false) {
        const bind = (anchor: HTMLElement, placement?: Placement) => {
          binding ??= createOverlayAnchor(overlay.surface, options);
          if (!options.paused?.()) {
            update(anchor, placement);
          }
        };
        if (options.lazy) {
          stopShow = listen(overlay.surface, "overlay-show", (event) => {
            if (event.target === overlay.surface && !event.defaultPrevented && !binding) {
              // A later veto may retain this binding; untouched menus never register one.
              const { anchor, placement } = target();
              bind(anchor ?? trigger(), placement);
            }
          });
        } else {
          bind(current, initialPlacement);
        }
      }
      return () => {
        stopShow?.();
        binding?.dispose();
        binding = undefined;
      };
    },
  };
}

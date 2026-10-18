import type { JSX } from "@solidjs/web";
import { onCleanup } from "solid-js";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import type { CheckoutChipOptions } from "./checkout-chip.ts";

type PickerLifecycle = Pick<
  CheckoutChipOptions,
  "popoverOpen" | "onPopoverShow" | "onPopoverHide" | "onPopoverAfterHide"
>;

/** Keeps the draft controller informed while the shared overlay owns dismissal and focus. */
export function PickerPopover(props: {
  id: string;
  label: string;
  anchor: HTMLElement;
  class: string;
  lifecycle: PickerLifecycle;
  children: JSX.Element;
  onAfterHide?: () => void;
  ref?: (handle: PopoverHandle) => void;
}) {
  let cleanup: (() => void) | undefined;
  onCleanup(() => cleanup?.());
  return (
    <Popover
      id={props.id}
      label={props.label}
      anchor={props.anchor}
      class={props.class}
      open={props.lifecycle.popoverOpen}
      placement="bottom-start"
      onOpenChange={(open) =>
        open ? props.lifecycle.onPopoverShow() : props.lifecycle.onPopoverHide()
      }
      ref={(handle) => {
        const surface = handle.overlay.surface;
        const afterHide = (event: Event) => {
          if (event.target !== surface) {
            return;
          }
          props.lifecycle.onPopoverAfterHide();
          props.onAfterHide?.();
        };
        const select = (event: MouseEvent) => {
          if (
            !event.defaultPrevented &&
            event.target instanceof Element &&
            event.target.closest('[data-popover="close"]')
          ) {
            handle.overlay.request(false, "return");
          }
        };
        surface.addEventListener("overlay-after-hide", afterHide);
        surface.addEventListener("click", select);
        cleanup = () => {
          surface.removeEventListener("overlay-after-hide", afterHide);
          surface.removeEventListener("click", select);
        };
        props.ref?.(handle);
      }}
    >
      {props.children}
    </Popover>
  );
}

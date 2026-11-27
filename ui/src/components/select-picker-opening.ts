import { onSettled } from "solid-js";
import type { OverlayPlacement } from "./overlay-anchor.ts";
import type { OverlayNativeAdapter } from "./overlay-types.ts";
import type { PickerOption, PickerParams } from "./select-picker-types.ts";

export const pickerSheetAdapter: OverlayNativeAdapter = {
  isOpen: (surface) => !surface.hidden,
  show: (surface) => {
    surface.hidden = false;
  },
  hide: (surface) => {
    surface.hidden = true;
  },
};

type PickerOpeningParams = Pick<PickerParams<PickerOption>, "disabled" | "pendingOptions">;

export function createPendingPickerOpen(read: () => PickerOpeningParams, hasFocus: () => boolean) {
  let requested: (() => void) | undefined;
  return {
    request(open: () => void) {
      const { disabled, pendingOptions } = read();
      if (!disabled || !pendingOptions || requested) {
        return;
      }
      requested = open;
      const finish = (ready: boolean) => {
        if (requested !== open) {
          return;
        }
        requested = undefined;
        if (ready && !read().disabled && hasFocus()) {
          open();
        }
      };
      void pendingOptions.then(
        () => onSettled(() => finish(true)),
        () => finish(false),
      );
    },
    cancel: () => {
      requested = undefined;
    },
  };
}

export function resolvePickerPlacement(
  placement: PickerParams<PickerOption>["placement"],
  variant: PickerParams<PickerOption>["variant"],
  direction: () => "rtl" | "ltr",
): OverlayPlacement {
  return variant === "submenu"
    ? direction() === "rtl"
      ? "left-start"
      : "right-start"
    : `${placement ?? "bottom"}-start`;
}

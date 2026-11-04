import { onSettled, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";
import { createPhoneSheetLayout } from "./solid/phone-sheet-layout.ts";

/** The bottom-sheet form of a picker's own surface: its phone test, swipe, grabber and close. */
export function createPickerPhoneSheet(options: {
  open: () => boolean;
  wanted: () => boolean;
  surface: () => HTMLElement;
  dismiss: () => void;
}) {
  const layout = createPhoneSheetLayout();
  let grabber!: HTMLDivElement;
  const active = () => options.open() && layout() && options.wanted();
  let releaseGesture: (() => void) | undefined;
  let gestureRequested = false;
  onSettled(() => () => releaseGesture?.());
  // The swipe's motion code only loads for a sheet someone actually opens.
  const bindGesture = async () => {
    gestureRequested = true;
    const { bindSheetDismissGesture } = await import("../lib/motion/sheet-dismiss.ts");
    releaseGesture = bindSheetDismissGesture({
      surface: options.surface(),
      handle: grabber,
      dismiss: options.dismiss,
    });
  };
  return {
    active,
    onOpenChange(next: boolean) {
      if (!next) {
        return;
      }
      if (!gestureRequested && layout() && options.wanted()) {
        void bindGesture();
      }
      // A swipe's exit leaves the surface off screen; the next opening starts clean.
      const surface = options.surface();
      for (const animation of surface.getAnimations()) {
        if (animation.effect?.getTiming().fill === "forwards") {
          animation.cancel();
        }
      }
      surface.style.removeProperty("transform");
      surface.style.removeProperty("pointer-events");
    },
    Chrome: (props: { searching: boolean }) => (
      <>
        <div
          ref={(element) => (grabber = element)}
          class="picker-select__grabber"
          hidden={!active()}
          aria-hidden="true"
        />
        <Show when={active() && !props.searching}>
          <button
            type="button"
            class="picker-select__sheet-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={options.dismiss}
          >
            <Icon name="x" />
          </button>
        </Show>
      </>
    ),
  };
}

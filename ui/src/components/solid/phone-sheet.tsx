import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { bindSheetDismissGesture, slideSheetOut } from "../../lib/motion/sheet-dismiss.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { tabbableElements } from "../focus-navigation.ts";
import { Icon } from "./icon.tsx";
import { createPhoneSheetLayout } from "./phone-sheet-layout.ts";
import { Popover, type PopoverHandle } from "./popover.tsx";
import "./phone-sheet.css";

export { createPhoneSheetLayout };

/**
 * A modal bottom sheet with a popover's trigger, handle, and in-place children, so a surface can
 * swap between the two. Children stay mounted while closed: form fields keep submitting. The
 * backdrop shares the panel's native top layer, so page stacking cannot leave anything tappable
 * behind the dim.
 */
export function PhoneSheet(props: {
  id: string;
  label: string;
  class?: JSX.HTMLAttributes<HTMLDivElement>["class"];
  anchor?: HTMLElement;
  trigger?: JSX.Element;
  triggerId?: string;
  triggerClass?: JSX.HTMLAttributes<HTMLButtonElement>["class"];
  triggerTitle?: string;
  children?: JSX.Element;
  onOpenChange?(open: boolean): void;
  ref?(handle: PopoverHandle): void;
}) {
  let handle: PopoverHandle | undefined;
  let backdrop!: HTMLElement;
  let panel!: HTMLElement;
  let grabber!: HTMLElement;
  let closeButton!: HTMLButtonElement;
  let closing = false;
  // An exit leaves the panel off screen; the next opening starts from a clean slate.
  let moved = false;
  const stops: (() => void)[] = [];
  const dismiss = () => {
    moved = true;
    handle?.overlay.request(false, "return");
  };
  const slideOutAndDismiss = () => {
    if (!handle || closing || !handle.overlay.open) {
      return;
    }
    closing = true;
    void slideSheetOut(panel, backdrop).then(dismiss);
  };
  const restore = () => {
    closing = false;
    if (!moved) {
      return;
    }
    moved = false;
    for (const element of [panel, backdrop]) {
      for (const animation of element.getAnimations()) {
        if (animation.effect?.getTiming().fill === "forwards") {
          animation.cancel();
        }
      }
      element.style.removeProperty("transform");
      element.style.removeProperty("opacity");
      element.style.removeProperty("pointer-events");
    }
  };
  // The sheet is modal: Tab wraps between its first and last controls.
  const wrapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented) {
      return;
    }
    const tabbable = [...tabbableElements(panel.children)];
    const boundary = event.shiftKey ? tabbable[0] : tabbable.at(-1);
    const target = event.shiftKey ? tabbable.at(-1) : tabbable[0];
    const active = panel.ownerDocument.activeElement;
    // A restored search hides Close, leaving the surface itself initially focused.
    if (!target || active === boundary || active === event.currentTarget) {
      event.preventDefault();
      target?.focus({ preventScroll: true });
    }
  };
  onSettled(() => () => {
    for (const stop of stops) {
      stop();
    }
  });
  return (
    <Popover
      id={props.id}
      label={props.label}
      anchor={props.anchor}
      trigger={props.trigger}
      triggerId={props.triggerId}
      triggerClass={props.triggerClass}
      triggerTitle={props.triggerTitle}
      class={["oc-sheet", props.class]}
      dismissOutsidePointer={false}
      dismissOutsideFocus={false}
      ref={(value) => {
        handle = value;
        const surface = value.overlay.surface;
        surface.setAttribute("aria-modal", "true");
        stops.push(
          bindSheetDismissGesture({
            surface: panel,
            handle: grabber,
            backdrop: () => backdrop,
            dismiss,
          }),
          listen(surface, "keydown", wrapTab),
        );
        props.ref?.({
          ...value,
          hide: () => {
            // A form can submit with the sheet closed; a late dismiss would close its next opening.
            if (!value.overlay.open) {
              return false;
            }
            slideOutAndDismiss();
            return true;
          },
        });
      }}
      onOpenChange={(open) => {
        if (open) {
          restore();
          // Focus the close button, not the first field, so a tap doesn't raise the keyboard.
          queueMicrotask(() => closeButton.focus({ preventScroll: true }));
        }
        props.onOpenChange?.(open);
      }}
    >
      <button
        ref={(element) => (backdrop = element)}
        type="button"
        class="oc-sheet__backdrop"
        tabindex={-1}
        aria-label={t("common.close")}
        onClick={slideOutAndDismiss}
      />
      <div ref={(element) => (panel = element)} class="oc-sheet__panel">
        <div ref={(element) => (grabber = element)} class="oc-sheet__grabber" aria-hidden="true" />
        <div class="oc-sheet__header">
          <h2 class="oc-sheet__title">{props.label}</h2>
          <button
            ref={(element) => (closeButton = element)}
            type="button"
            class="oc-sheet__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={slideOutAndDismiss}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="oc-sheet__body">{props.children}</div>
      </div>
    </Popover>
  );
}

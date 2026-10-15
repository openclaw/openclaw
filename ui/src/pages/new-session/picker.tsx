import type { JSX } from "@solidjs/web";
import { onCleanup } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import type { CheckoutChipOptions } from "./checkout-chip.ts";

type PickerState = Pick<
  CheckoutChipOptions,
  | "submitting"
  | "pendingPlacement"
  | "popoverOpen"
  | "onPopoverShow"
  | "onPopoverHide"
  | "onPopoverAfterHide"
>;

export function SessionPicker(props: {
  kind: "where" | "project" | "checkout";
  label: string;
  value: string;
  icon: JSX.Element;
  summary?: string;
  triggerAttributes?: Pick<
    JSX.HTMLAttributes<HTMLButtonElement>,
    "title" | "aria-label" | "aria-description"
  > & { [name: `data-${string}`]: string | undefined };
  state: PickerState;
  children: JSX.Element;
  onAfterHide?: () => void;
  ref?: (handle: PopoverHandle) => void;
}) {
  let trigger!: HTMLButtonElement;
  let popover!: PopoverHandle;
  let cleanup: (() => void) | undefined;
  onCleanup(() => cleanup?.());
  return (
    <>
      <span
        class={[
          "new-session-page__select",
          { "new-session-page__select--where": props.kind === "where" },
        ]}
      >
        <button
          aria-label={props.label}
          {...props.triggerAttributes}
          id={`new-session-${props.kind}-trigger`}
          ref={(node) => {
            trigger = node;
          }}
          type="button"
          class="new-session-page__trigger"
          aria-haspopup="dialog"
          aria-controls={`new-session-${props.kind}-popover`}
          aria-expanded={props.state.popoverOpen ? "true" : "false"}
          disabled={props.state.submitting || props.state.pendingPlacement}
          onClick={() => popover.overlay.request(!popover.overlay.open)}
        >
          <span class="new-session-page__target-icon" aria-hidden="true">
            {props.icon}
          </span>
          <span class="new-session-page__trigger-label">{props.value}</span>
          {props.summary ? (
            <>
              {" "}
              <span class="new-session-page__trigger-summary">{props.summary}</span>
            </>
          ) : undefined}
          <span
            class="new-session-page__trigger-chevron new-session-page__trigger-chevron--desktop"
            aria-hidden="true"
          >
            <Icon name="chevronDown" />
          </span>
          <span
            class="new-session-page__trigger-chevron new-session-page__trigger-chevron--mobile"
            aria-hidden="true"
          >
            <Icon name="chevronsUpDown" />
          </span>
        </button>
      </span>
      <Popover
        id={`new-session-${props.kind}-popover`}
        label={props.label}
        anchor={trigger}
        class={`new-session-page__select new-session-page__${props.kind}-popover new-session-page__picker-popover`}
        open={props.state.popoverOpen}
        placement="bottom-start"
        onOpenChange={(open) => (open ? props.state.onPopoverShow() : props.state.onPopoverHide())}
        ref={(handle) => {
          popover = handle;
          const surface = handle.overlay.surface;
          const afterHide = (event: Event) => {
            if (event.target !== surface) {
              return;
            }
            props.state.onPopoverAfterHide();
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
    </>
  );
}

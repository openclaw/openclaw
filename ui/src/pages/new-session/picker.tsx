import type { JSX } from "@solidjs/web";
import { onCleanup } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { listen } from "../../lib/reactive/listener.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

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
  params: NewSessionPlaceControlsOptions;
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
          aria-expanded={props.params.place.browser.popoverOpen(props.kind) ? "true" : "false"}
          disabled={
            props.params.submitting ||
            props.params.pendingPlacement ||
            (props.kind === "where" && props.params.place.suggestedCloudProfile.pending)
          }
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
        class={[
          "new-session-page__select",
          `new-session-page__${props.kind}-popover`,
          "new-session-page__picker-popover",
        ]}
        open={props.params.place.browser.popoverOpen(props.kind)}
        placement="bottom-start"
        onOpenChange={(open) => {
          const callbacks = props.params.place.browser.popoverCallbacks(props.kind);
          callbacks[open ? "onPopoverShow" : "onPopoverHide"]();
        }}
        ref={(handle) => {
          popover = handle;
          const surface = handle.overlay.surface;
          const stops = [
            listen(surface, "overlay-after-hide", (event) => {
              if (event.target === surface) {
                const active = surface.ownerDocument.activeElement;
                if (!active || active === surface.ownerDocument.body || surface.contains(active)) {
                  trigger.focus();
                }
                props.params.place.browser.popoverCallbacks(props.kind).onPopoverAfterHide();
                props.onAfterHide?.();
              }
            }),
            listen(surface, "click", (event) => {
              if (
                !event.defaultPrevented &&
                event.target instanceof Element &&
                event.target.closest('[data-popover="close"]')
              ) {
                handle.overlay.request(false, "return");
              }
            }),
          ];
          cleanup = () => stops.forEach((stop) => stop());
          props.ref?.(handle);
        }}
      >
        {props.children}
      </Popover>
    </>
  );
}

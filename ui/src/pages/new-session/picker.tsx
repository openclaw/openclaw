import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, onSettled } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createScrollStateRef } from "../../lib/reactive/scroll-state.ts";
import { createPickerNavigation, PickerNavigation } from "./picker-navigation.ts";
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
  lazy?: boolean;
  onBeforeShow?: (event: Event) => void;
  onAfterHide?: () => void;
  ref?: (handle: PopoverHandle) => void;
}) {
  const navigation = props.kind === "checkout" ? null : createPickerNavigation();
  let trigger!: HTMLButtonElement;
  let popover!: PopoverHandle;
  let cleanup: (() => void) | undefined;
  onSettled(() => () => cleanup?.());
  return (
    <>
      <span
        class={[
          "new-session-page__select",
          {
            "new-session-page__select--where": props.kind === "where",
            "new-session-page__select--project": props.kind === "project",
            "new-session-page__select--checkout": props.kind === "checkout",
          },
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
          <Icon name="chevronsUpDown" class="new-session-page__picker-chevron" />
        </button>
      </span>
      <Popover
        sameRoot
        lazy={props.lazy}
        onBeforeShow={props.onBeforeShow}
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
          if (!open) {
            navigation?.clear();
          }
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
        <div class="new-session-page__picker-panel">
          <Errored
            fallback={(error, retry) => (
              <PickerLoadError
                error={error()}
                retry={retry}
                isOpen={() => props.params.place.browser.popoverOpen(props.kind)}
              />
            )}
          >
            <Loading fallback={<PickerSkeleton />}>
              <PickerNavigation value={navigation}>{props.children}</PickerNavigation>
            </Loading>
          </Errored>
        </div>
      </Popover>
    </>
  );
}

function PickerLoadError(props: { error: unknown; retry: () => void; isOpen: () => boolean }) {
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  const retry = async () => {
    const stale = isStaleChunkImportError(props.error);
    const reloading =
      stale &&
      (await retryStaleChunkReloadWhenReachable({
        canReload: () => active && props.isOpen(),
      }));
    if (active && props.isOpen() && !reloading) {
      props.retry();
    }
  };
  return (
    <LazyViewError
      error={props.error}
      stale={isStaleChunkImportError(props.error)}
      onRetry={() => void retry()}
      inline
    />
  );
}

export function createPickerScrollRef(presented: () => boolean, content: () => unknown) {
  return createScrollStateRef(
    (element, state) => {
      element.toggleAttribute("data-fade-start", !state.atStart);
      element.toggleAttribute("data-fade-end", !state.atEnd);
    },
    { presented, content },
  );
}

/** Shared geometry for pending controls and pending panel rows. */
export function PickerSkeleton(props: { tray?: boolean; checkout?: boolean; section?: string }) {
  return (
    <div
      class={[
        "new-session-page__skeletons",
        {
          "new-session-page__skeletons--tray": props.tray,
          "new-session-page__environment-skeletons": Boolean(props.section),
        },
      ]}
      data-section={props.section}
    >
      <span class="sr-only" role="status">
        {t("common.loading")}
      </span>
      <For
        each={props.tray ? (props.checkout ? [112, 84, 72] : [112, 84]) : [148, 116, 132]}
        keyed={(width) => width}
      >
        {(width, index) => (
          <span
            class="new-session-page__skeleton-row"
            aria-hidden="true"
            style={{ "animation-delay": `${index() * 90}ms` }}
          >
            <span class="new-session-page__skeleton-icon" />
            <span class="new-session-page__skeleton-bar" style={{ width: `${width()}px` }} />
          </span>
        )}
      </For>
    </div>
  );
}

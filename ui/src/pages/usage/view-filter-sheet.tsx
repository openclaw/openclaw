import type { JSX } from "@solidjs/web";
import { Show, createSignal, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { bindSheetDismissGesture, slideSheetOut } from "../../lib/motion/sheet-dismiss.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";

const TABBABLE = "a[href], button, input, select, textarea, [tabindex]";

function UsageFilterSheetSurface(props: {
  anchor: HTMLElement;
  children: JSX.Element;
  onClose: () => void;
}) {
  let handle: PopoverHandle | undefined;
  let backdrop!: HTMLElement;
  let panel!: HTMLElement;
  let grabber!: HTMLElement;
  let closeButton!: HTMLButtonElement;
  let closing = false;
  const stops: (() => void)[] = [];
  const dismiss = () => handle?.overlay.request(false, "return");
  const slideOutAndDismiss = () => {
    if (!handle || closing) {
      return;
    }
    closing = true;
    void slideSheetOut(panel, backdrop).then(dismiss);
  };
  // The sheet is modal: Tab wraps between its first and last controls.
  const wrapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented) {
      return;
    }
    const tabbable = [...panel.querySelectorAll<HTMLElement>(TABBABLE)].filter(
      (element) =>
        element.tabIndex >= 0 && !element.matches(":disabled") && element.checkVisibility(),
    );
    const boundary = event.shiftKey ? tabbable[0] : tabbable.at(-1);
    const target = event.shiftKey ? tabbable.at(-1) : tabbable[0];
    if (!target || panel.ownerDocument.activeElement === boundary) {
      event.preventDefault();
      target?.focus({ preventScroll: true });
    }
  };
  onSettled(() => () => {
    for (const stop of stops) {
      stop();
    }
  });
  // The whole sheet shares the native top layer, so the dimmed page is never hit-testable
  // and the page's own stacking and containment cannot reach the backdrop.
  return (
    <Popover
      id="usage-filter-sheet"
      label={t("usage.filters.title")}
      anchor={props.anchor}
      class="usage-filter-sheet"
      open
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
      }}
      onOpenChange={(open) => {
        if (open) {
          queueMicrotask(() => closeButton.focus({ preventScroll: true }));
        } else {
          props.onClose();
        }
      }}
    >
      <button
        ref={(element) => (backdrop = element)}
        type="button"
        class="usage-filter-sheet__backdrop"
        tabindex={-1}
        aria-label={t("common.close")}
        onClick={slideOutAndDismiss}
      />
      <div ref={(element) => (panel = element)} class="usage-filter-sheet__panel">
        <div
          ref={(element) => (grabber = element)}
          class="usage-filter-sheet__grabber"
          aria-hidden="true"
        />
        <div class="usage-filter-sheet__header">
          <h2 class="usage-filter-sheet__title">{t("usage.filters.title")}</h2>
          <button
            ref={(element) => (closeButton = element)}
            type="button"
            class="usage-filter-sheet__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={slideOutAndDismiss}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="usage-filter-sheet__body">{props.children}</div>
      </div>
    </Popover>
  );
}

export function UsageFilterSheet(props: { active: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  return (
    <>
      <button
        ref={(element) => (trigger = element)}
        type="button"
        class={["btn btn--sm usage-filter-sheet__trigger", { active: props.active }]}
        title={t("usage.filters.title")}
        aria-label={t("usage.filters.title")}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
      >
        <Icon name="listFilter" />
      </button>
      <Show when={open()}>
        <UsageFilterSheetSurface anchor={trigger} onClose={() => setOpen(false)}>
          {props.children}
        </UsageFilterSheetSurface>
      </Show>
    </>
  );
}

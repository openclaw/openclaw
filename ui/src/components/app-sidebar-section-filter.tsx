import { createSignal, For, Show } from "solid-js";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";

export type SidebarSectionFilterPicker = {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
};

/**
 * A section sidebar's filter button and popover, styled like the Users filter: one submenu
 * picker per choice, and Reset while anything differs from the defaults.
 */
export function SidebarSectionFilter(props: {
  label: string;
  pickers: readonly SidebarSectionFilterPicker[];
  filtered: boolean;
  resetLabel: string;
  onReset: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const sheet = createMediaQuery(mobileNavLayoutMediaQuery(), isMobileNavLayout());
  const pickers = new Map<string, PickerFocusHandle>();
  let trigger: HTMLButtonElement | undefined;
  let reset: HTMLButtonElement | undefined;
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      trigger?.focus({ preventScroll: true });
    }
  };
  return (
    <>
      <button
        ref={(element) => (trigger = element)}
        type="button"
        class={[
          "sidebar-session-toolbar__button sidebar-session-sort",
          { "sidebar-session-sort--filtered": props.filtered },
        ]}
        title={props.label}
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
      >
        <Icon name="listFilter" />
      </button>
      <Show when={open()}>
        <SidebarSessionFilterPopover
          class="sidebar-session-sort-menu sidebar-people-filter-menu"
          anchor={trigger ?? null}
          label={props.label}
          initialFocus={() => pickers.get(props.pickers[0]?.id ?? "")?.trigger}
          focusTargets={() => [
            ...[...pickers.values()].flatMap((picker) => picker.elements()),
            ...(reset ? [reset] : []),
          ]}
          onClose={close}
          content={
            <>
              <div class="sidebar-session-menu-section">
                <For each={props.pickers}>
                  {(picker) => (
                    <Picker
                      focusRef={(handle) => pickers.set(picker.id, handle)}
                      id={picker.id}
                      label={picker.label}
                      value={picker.value}
                      variant="submenu"
                      sheet={sheet()}
                      showOptionTooltips={false}
                      options={[...picker.options]}
                      onChange={(value) => {
                        picker.onChange(value);
                        close(true);
                      }}
                    />
                  )}
                </For>
              </div>
              <Show when={props.filtered}>
                <footer class="sidebar-session-menu-footer">
                  <button
                    ref={(element) => (reset = element)}
                    type="button"
                    class="sidebar-session-filter-footer"
                    onClick={() => {
                      props.onReset();
                      close(true);
                    }}
                  >
                    {props.resetLabel}
                  </button>
                </footer>
              </Show>
            </>
          }
        />
      </Show>
    </>
  );
}

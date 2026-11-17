import { createSignal, For, Show } from "solid-js";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
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
 * A section sidebar's filter popover, built like the Users filter: one submenu picker per
 * choice, and Reset while anything differs from the defaults.
 */
export function renderSidebarSectionFilterMenu(
  menus: SidebarMenus,
  menu: "automationsFilter",
  options: SectionFilterOptions,
) {
  const position = menus[`${menu}MenuPosition`];
  const commit = (update: () => void) => {
    if (menus[`${menu}MenuPosition`] !== position) {
      return;
    }
    update();
    menus.closePositionedMenu(menu, { restoreFocus: true });
  };
  return (
    <SectionFilterPopover
      options={options}
      anchor={menus.triggers.get(menu) ?? null}
      onClose={menus.positionedMenuHandlers(menu).onClose}
      commit={commit}
    />
  );
}

type SectionFilterOptions = {
  label: string;
  resetLabel: string;
  pickers: () => readonly SidebarSectionFilterPicker[];
  filtered: () => boolean;
  onReset: () => void;
};

export function SectionFilter(props: { options: SectionFilterOptions }) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
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
          { "sidebar-session-sort--filtered": props.options.filtered() },
        ]}
        aria-label={props.options.label}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
      >
        <Icon name="listFilter" />
      </button>
      <Show when={open()}>
        <SectionFilterPopover
          options={props.options}
          anchor={trigger ?? null}
          onClose={close}
          commit={(update) => {
            update();
            close(true);
          }}
        />
      </Show>
    </>
  );
}

function SectionFilterPopover(props: {
  options: SectionFilterOptions;
  anchor: HTMLElement | null;
  onClose: (restoreFocus: boolean) => void;
  commit: (update: () => void) => void;
}) {
  const pickers = new Map<string, PickerFocusHandle>();
  let reset: HTMLButtonElement | undefined;
  const sheet = createMediaQuery(mobileNavLayoutMediaQuery(), isMobileNavLayout());
  return (
    <SidebarSessionFilterPopover
      class="sidebar-session-sort-menu sidebar-people-filter-menu"
      anchor={props.anchor}
      label={props.options.label}
      initialFocus={() => pickers.get(props.options.pickers()[0]?.id ?? "")?.trigger}
      focusTargets={() => [
        ...[...pickers.values()].flatMap((picker) => picker.elements()),
        ...(reset ? [reset] : []),
      ]}
      onClose={(restore) => props.onClose(restore)}
      content={
        <>
          <div class="sidebar-session-menu-section">
            <For each={props.options.pickers()}>
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
                  onChange={(value) => props.commit(() => picker.onChange(value))}
                />
              )}
            </For>
          </div>
          {props.options.filtered() ? (
            <footer class="sidebar-session-menu-footer">
              <button
                ref={(element) => (reset = element)}
                type="button"
                class="sidebar-session-filter-footer"
                onClick={() => props.commit(props.options.onReset)}
              >
                {props.options.resetLabel}
              </button>
            </footer>
          ) : undefined}
        </>
      }
    />
  );
}

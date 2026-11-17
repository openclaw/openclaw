import { For } from "solid-js";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
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
  options: {
    label: string;
    resetLabel: string;
    pickers: () => readonly SidebarSectionFilterPicker[];
    filtered: () => boolean;
    onReset: () => void;
  },
) {
  const pickers = new Map<string, PickerFocusHandle>();
  let reset: HTMLButtonElement | undefined;
  const sheet = createMediaQuery(mobileNavLayoutMediaQuery(), isMobileNavLayout());
  const position = menus[`${menu}MenuPosition`];
  const commit = (update: () => void) => {
    if (menus[`${menu}MenuPosition`] !== position) {
      return;
    }
    update();
    menus.closePositionedMenu(menu, { restoreFocus: true });
  };
  return (
    <SidebarSessionFilterPopover
      class="sidebar-session-sort-menu sidebar-people-filter-menu"
      anchor={menus.triggers.get(menu) ?? null}
      label={options.label}
      initialFocus={() => pickers.get(options.pickers()[0]?.id ?? "")?.trigger}
      focusTargets={() => [
        ...[...pickers.values()].flatMap((picker) => picker.elements()),
        ...(reset ? [reset] : []),
      ]}
      onClose={menus.positionedMenuHandlers(menu).onClose}
      content={
        <>
          <div class="sidebar-session-menu-section">
            <For each={options.pickers()}>
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
                  onChange={(value) => commit(() => picker.onChange(value))}
                />
              )}
            </For>
          </div>
          {options.filtered() ? (
            <footer class="sidebar-session-menu-footer">
              <button
                ref={(element) => (reset = element)}
                type="button"
                class="sidebar-session-filter-footer"
                onClick={() => commit(options.onReset)}
              >
                {options.resetLabel}
              </button>
            </footer>
          ) : undefined}
        </>
      }
    />
  );
}

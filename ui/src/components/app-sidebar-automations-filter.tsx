import { createSignal, Show } from "solid-js";
import { isMobileNavLayout, mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import {
  automationsFilter,
  DEFAULT_AUTOMATIONS_FILTER,
  setAutomationsFilter,
  type AutomationsFilter,
} from "../lib/cron/automations-navigation.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";

registerEnglishCatalog(registerCronEnglish);

/** The Automations sidebar's filter button and its popover, styled like the Users filter. */
export function SidebarAutomationsFilter() {
  const [open, setOpen] = createSignal(false);
  const sheet = createMediaQuery(mobileNavLayoutMediaQuery(), isMobileNavLayout());
  const pickers = new Map<string, PickerFocusHandle>();
  let trigger: HTMLButtonElement | undefined;
  let reset: HTMLButtonElement | undefined;
  const filtered = () => {
    const filter = automationsFilter();
    return (
      filter.status !== DEFAULT_AUTOMATIONS_FILTER.status ||
      filter.lastRun !== DEFAULT_AUTOMATIONS_FILTER.lastRun ||
      filter.sort !== DEFAULT_AUTOMATIONS_FILTER.sort
    );
  };
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      trigger?.focus({ preventScroll: true });
    }
  };
  const commit = (patch: Partial<AutomationsFilter>) => {
    setAutomationsFilter({ ...automationsFilter(), ...patch });
    close(true);
  };
  return (
    <>
      <button
        ref={(element) => (trigger = element)}
        type="button"
        class={[
          "sidebar-session-toolbar__button sidebar-session-sort",
          { "sidebar-session-sort--filtered": filtered() },
        ]}
        title={t("cron.list.filters")}
        aria-label={t("cron.list.filters")}
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
          label={t("cron.list.filters")}
          initialFocus={() => pickers.get("status")?.trigger}
          focusTargets={() => [
            ...[...pickers.values()].flatMap((picker) => picker.elements()),
            ...(reset ? [reset] : []),
          ]}
          onClose={close}
          content={
            <>
              <div class="sidebar-session-menu-section">
                <Picker
                  focusRef={(handle) => pickers.set("status", handle)}
                  id="sidebar-automations-status"
                  label={t("cron.runs.status")}
                  value={automationsFilter().status}
                  variant="submenu"
                  sheet={sheet()}
                  showOptionTooltips={false}
                  options={[
                    { value: "all", label: t("cron.tabs.all") },
                    { value: "active", label: t("cron.tabs.active") },
                    { value: "paused", label: t("cron.tabs.paused") },
                  ]}
                  onChange={(value) => {
                    if (value === "all" || value === "active" || value === "paused") {
                      commit({ status: value });
                    }
                  }}
                />
                <Picker
                  focusRef={(handle) => pickers.set("lastRun", handle)}
                  id="sidebar-automations-last-run"
                  label={t("cron.jobs.lastRun")}
                  value={automationsFilter().lastRun}
                  variant="submenu"
                  sheet={sheet()}
                  showOptionTooltips={false}
                  options={[
                    { value: "all", label: t("cron.jobs.all") },
                    { value: "ok", label: t("cron.runs.runStatusOk") },
                    { value: "error", label: t("cron.runs.runStatusError") },
                  ]}
                  onChange={(value) => {
                    if (value === "all" || value === "ok" || value === "error") {
                      commit({ lastRun: value });
                    }
                  }}
                />
                <Picker
                  focusRef={(handle) => pickers.set("sort", handle)}
                  id="sidebar-automations-sort"
                  label={t("cron.jobs.sort")}
                  value={automationsFilter().sort}
                  variant="submenu"
                  sheet={sheet()}
                  showOptionTooltips={false}
                  options={[
                    { value: "name", label: t("cron.jobs.name") },
                    { value: "nextRunAtMs", label: t("cron.jobs.nextRun") },
                    { value: "updatedAtMs", label: t("cron.jobs.recentlyUpdated") },
                  ]}
                  onChange={(value) => {
                    if (value === "name" || value === "nextRunAtMs" || value === "updatedAtMs") {
                      commit({ sort: value });
                    }
                  }}
                />
              </div>
              <Show when={filtered()}>
                <footer class="sidebar-session-menu-footer">
                  <button
                    ref={(element) => (reset = element)}
                    type="button"
                    class="sidebar-session-filter-footer"
                    onClick={() => commit(DEFAULT_AUTOMATIONS_FILTER)}
                  >
                    {t("cron.jobs.reset")}
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

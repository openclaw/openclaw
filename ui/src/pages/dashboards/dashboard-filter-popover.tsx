import { For, Show, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { DashboardGalleryFilters, DashboardGalleryHandlers } from "./gallery-filters.ts";

const ARROW_STEPS: Record<string, number> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

// Arrow keys check the next option, the same as tapping it, and move focus with it.
function moveCheckedOption(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
  const step = ARROW_STEPS[event.key];
  const options = [...event.currentTarget.children].filter(
    (option): option is HTMLElement => option instanceof HTMLElement,
  );
  const current = options.findIndex((option) => option === event.target);
  if (step === undefined || current < 0) {
    return;
  }
  event.preventDefault();
  const next = options[(current + step + options.length) % options.length]!;
  next.click();
  next.focus();
}

function DashboardFilterOption(props: {
  label: string;
  checked: boolean;
  tabbable?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class="oc-menu-item"
      role="radio"
      aria-checked={props.checked ? "true" : "false"}
      tabindex={props.checked || props.tabbable ? 0 : -1}
      onClick={() => props.onSelect()}
    >
      <span class="oc-menu-item__check" aria-hidden="true">
        <Show when={props.checked}>
          <Icon name="check" />
        </Show>
      </span>
      <span class="oc-menu-item__label oc-menu-item__label--text">{props.label}</span>
    </button>
  );
}

// Phone widths swap the labeled selects for this popover; both drive the same filters.
export function DashboardFilterPopover(props: {
  owners: readonly { id: string; label: string }[];
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
}) {
  let root!: HTMLDivElement;
  let popover: PopoverHandle | undefined;
  // A tap outside only dismisses: the click that follows must not open the card underneath.
  onSettled(() => {
    let dismissing = false;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    listen(
      document,
      "pointerdown",
      (event) => {
        dismissing = Boolean(popover?.overlay.open) && !event.composedPath().includes(root);
      },
      options,
    );
    listen(document, "pointercancel", () => (dismissing = false), options);
    listen(
      document,
      "click",
      (event) => {
        if (dismissing && event.detail > 0) {
          event.preventDefault();
          event.stopPropagation();
        }
        dismissing = false;
      },
      options,
    );
    return () => controller.abort();
  });
  const sorts = () =>
    [
      ["updated", t("dashboardsPage.sortUpdated")],
      ["title", t("dashboardsPage.sortTitle")],
    ] as const;
  return (
    <div ref={(element) => (root = element)} class="dashboards-filter">
      <Popover
        ref={(handle) => (popover = handle)}
        id="dashboards-filter-popover"
        class="dashboards-filter__popover"
        label={t("chat.sidebar.menuFilters")}
        lazy="while-open"
        placement="bottom-end"
        triggerClass={[
          "btn btn--sm dashboards-filter__trigger",
          { active: props.filters.ownerId !== "" || props.filters.sort !== "updated" },
        ]}
        triggerTitle={t("chat.sidebar.menuFilters")}
        trigger={<Icon name="listFilter" />}
      >
        <h6 id="dashboards-filter-author" class="dashboards-filter__heading">
          {t("dashboardsPage.authorFilter")}
        </h6>
        {/* A long author list scrolls on its own so Sort stays in view. */}
        <div
          class="dashboards-filter__authors"
          role="radiogroup"
          aria-labelledby="dashboards-filter-author"
          onKeyDown={moveCheckedOption}
        >
          <DashboardFilterOption
            label={t("dashboardsPage.allAuthors")}
            checked={props.filters.ownerId === ""}
            tabbable={!props.owners.some((owner) => owner.id === props.filters.ownerId)}
            onSelect={() => props.handlers.onFilterChange({ ownerId: "" })}
          />
          <For each={props.owners} keyed={(owner) => owner.id}>
            {(owner) => (
              <DashboardFilterOption
                label={owner().label}
                checked={props.filters.ownerId === owner().id}
                onSelect={() => props.handlers.onFilterChange({ ownerId: owner().id })}
              />
            )}
          </For>
        </div>
        <h6 id="dashboards-filter-sort" class="dashboards-filter__heading">
          {t("dashboardsPage.sortLabel")}
        </h6>
        <div
          role="radiogroup"
          aria-labelledby="dashboards-filter-sort"
          onKeyDown={moveCheckedOption}
        >
          <For each={sorts()} keyed={([sort]) => sort}>
            {(entry) => (
              <DashboardFilterOption
                label={entry()[1]}
                checked={props.filters.sort === entry()[0]}
                onSelect={() => props.handlers.onFilterChange({ sort: entry()[0] })}
              />
            )}
          </For>
        </div>
      </Popover>
    </div>
  );
}

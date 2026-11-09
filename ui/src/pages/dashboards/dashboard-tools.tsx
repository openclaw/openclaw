import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { HeaderSearchField } from "../../components/solid/header-search.tsx";
import { IconButton, iconButtonClass } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import { SessionOwnerChip } from "../../components/solid/session-owner-chip.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionCreatedActor } from "../../lib/session-owner.ts";
import type { DashboardGalleryFilters, DashboardGalleryHandlers } from "./gallery-filters.ts";

export type DashboardAuthorOption = {
  id: string;
  label: string;
  avatar: SessionCreatedActor;
  count: number;
};

// The author search earns its place only once the list is long.
const AUTHOR_SEARCH_MIN = 8;

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export function authorDisplayName(author: { id: string; label: string }, selfId?: string) {
  return author.id === selfId ? t("dashboardsPage.you") : author.label;
}

/** Search icon that becomes the field; it stays open while it holds a query. */
export function DashboardSearch(props: { query: string; onQueryChange: (query: string) => void }) {
  const [open, setOpen] = createSignal(false);
  let toggle: HTMLButtonElement | undefined;
  const close = () => {
    props.onQueryChange("");
    setOpen(false);
    queueMicrotask(() => toggle?.focus({ preventScroll: true }));
  };
  return (
    <Show
      when={open() || props.query}
      fallback={
        <span class="dashboards-search-toggle">
          <IconButton
            ref={(element) => (toggle = element)}
            size={36}
            icon="search"
            label={t("dashboardsPage.searchLabel")}
            onClick={() => setOpen(true)}
          />
        </span>
      }
    >
      <label class="dashboards-search">
        <span class="dashboards-search__icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <HeaderSearchField
          label={t("dashboardsPage.searchLabel")}
          placeholder={t("dashboardsPage.searchPlaceholder")}
          query={props.query}
          onQueryChange={props.onQueryChange}
          onClose={close}
        />
        <IconButton
          size={28}
          icon="x"
          label={t("dashboardsPage.closeSearch")}
          tooltip={false}
          onClick={close}
        />
      </label>
    </Show>
  );
}

function AuthorName(props: { name: string; query: string }) {
  const parts = createMemo(() => {
    const query = props.query.trim();
    const index = query ? fold(props.name).indexOf(fold(query)) : -1;
    return index < 0
      ? null
      : [
          props.name.slice(0, index),
          props.name.slice(index, index + query.length),
          props.name.slice(index + query.length),
        ];
  });
  return (
    <Show when={parts()} fallback={props.name}>
      {(match) => (
        <>
          {match()[0]}
          <b>{match()[1]}</b>
          {match()[2]}
        </>
      )}
    </Show>
  );
}

/** One filter, so the button opens the author list directly. */
export function DashboardAuthorFilter(props: {
  authors: readonly DashboardAuthorOption[];
  selfId?: string;
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
}) {
  const [query, setQuery] = createSignal("");
  const selected = () => props.filters.ownerIds;
  const searchable = () => props.authors.length > AUTHOR_SEARCH_MIN;
  // You first, then the selected authors, then everyone by dashboard count (ties A–Z).
  const rows = createMemo(() => {
    const q = fold(query().trim());
    const byCount = (left: DashboardAuthorOption, right: DashboardAuthorOption) =>
      right.count - left.count || left.label.localeCompare(right.label);
    const matching = props.authors.filter(
      (author) =>
        !q ||
        fold(author.label).includes(q) ||
        (author.id === props.selfId && fold(t("dashboardsPage.you")).startsWith(q)),
    );
    const self = matching.filter((author) => author.id === props.selfId);
    const picked = matching
      .filter((author) => author.id !== props.selfId && selected().includes(author.id))
      .toSorted(byCount);
    const rest = matching
      .filter((author) => author.id !== props.selfId && !selected().includes(author.id))
      .toSorted(byCount);
    return { list: [...self, ...picked, ...rest], pinned: self.length + picked.length };
  });
  const toggle = (id: string) =>
    props.handlers.onFilterChange({
      ownerIds: selected().includes(id)
        ? selected().filter((owner) => owner !== id)
        : [...selected(), id],
    });
  const clear = () => (
    <Show when={selected().length > 0}>
      <button
        type="button"
        class="dashboards-authors__clear"
        onClick={() => props.handlers.onFilterChange({ ownerIds: [] })}
      >
        {t("dashboardsPage.clearAuthors")}
      </button>
    </Show>
  );
  return (
    <Popover
      id="dashboards-author-filter"
      class="dashboards-authors"
      label={t("dashboardsPage.filterByAuthor")}
      lazy="while-open"
      placement="bottom-end"
      triggerClass={[
        iconButtonClass({ size: 36 }),
        "dashboards-tools__trigger",
        { active: selected().length > 0 },
      ]}
      triggerTitle={t("dashboardsPage.filterByAuthor")}
      triggerAriaLabel={t("dashboardsPage.filterByAuthor")}
      trigger={<Icon name="listFilter" />}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
    >
      <Show
        when={searchable()}
        fallback={
          <Show when={selected().length > 0}>
            <div class="dashboards-authors__bar">{clear()}</div>
          </Show>
        }
      >
        <div class="dashboards-authors__search">
          <span aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            ref={(element) => queueMicrotask(() => element.focus({ preventScroll: true }))}
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder={t("dashboardsPage.filterAuthors")}
            aria-label={t("dashboardsPage.filterAuthors")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {clear()}
        </div>
      </Show>
      <div
        class="dashboards-authors__list"
        role="group"
        aria-label={t("dashboardsPage.filterByAuthor")}
      >
        <Show
          when={rows().list.length > 0}
          fallback={
            <div class="dashboards-authors__none">
              {t("dashboardsPage.noAuthorsMatch", { query: query().trim() })}
            </div>
          }
        >
          <For each={rows().list} keyed={(author) => author.id}>
            {(author, index) => (
              <label
                class={[
                  "dashboards-authors__row",
                  {
                    "dashboards-authors__row--after-pinned":
                      index() === rows().pinned && index() > 0,
                  },
                ]}
              >
                <Checkbox
                  checked={selected().includes(author().id)}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    toggle(author().id);
                    // Selection reorders rows; retain focus on the moved checkbox.
                    onSettled(() => input.focus({ preventScroll: true }));
                  }}
                />
                <SessionOwnerChip owner={author().avatar} size="row" />
                <span class="dashboards-authors__name">
                  <AuthorName
                    name={authorDisplayName(author(), props.selfId)}
                    query={author().id === props.selfId ? "" : query()}
                  />
                </span>
                <span class="dashboards-authors__count">{author().count}</span>
              </label>
            )}
          </For>
        </Show>
      </div>
    </Popover>
  );
}

/** The applied filter: one author by name, several collapse to a count. */
export function DashboardAuthorChip(props: {
  authors: readonly DashboardAuthorOption[];
  selfId?: string;
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
}) {
  const picked = createMemo(() =>
    props.filters.ownerIds
      .map((id) => props.authors.find((author) => author.id === id))
      .filter((author): author is DashboardAuthorOption => Boolean(author)),
  );
  return (
    <Show when={picked().length > 0}>
      <div class="dashboards-chips">
        <span class="dashboards-chip">
          <Show
            when={picked().length > 1}
            fallback={
              <>
                <span class="dashboards-chip__prefix">{t("dashboardsPage.authorIs")}</span>
                <SessionOwnerChip owner={picked()[0]!.avatar} size="row" />
                <span>{authorDisplayName(picked()[0]!, props.selfId)}</span>
              </>
            }
          >
            <span class="dashboards-chip__stack" aria-hidden="true">
              <For each={picked().slice(0, 3)} keyed={(author) => author.id}>
                {(author) => <SessionOwnerChip owner={author().avatar} size="row" />}
              </For>
            </span>
            <span>{t("dashboardsPage.authorCount", { count: String(picked().length) })}</span>
          </Show>
          <IconButton
            size={28}
            icon="x"
            class="dashboards-chip__remove"
            label={t("dashboardsPage.removeAuthorFilter")}
            tooltip={false}
            onClick={() => props.handlers.onFilterChange({ ownerIds: [] })}
          />
        </span>
      </div>
    </Show>
  );
}

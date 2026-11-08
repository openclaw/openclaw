import { createMemo, createSignal, For, Show } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import { HeaderSearchField } from "../../components/solid/header-search.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { MenuHeading } from "../../components/solid/menu-heading.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import {
  presenceActivityLabel,
  presenceViewerActivity,
  presenceViewerLabel,
  presenceUserLabel,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { registerEnglishCatalog, getLocale, t } from "../../lib/reactive/i18n.ts";
import type { SessionActivityFilters } from "./session-activity.ts";

registerEnglishCatalog(registerActivityEnglish);

type ActivityPerson = PresenceViewer & {
  count: number;
};

type PeopleView = {
  filters: SessionActivityFilters;
  onFiltersChange: (filters: SessionActivityFilters) => void;
  presentationRevision?: number;
  result?: Pick<SessionsListResult, "peopleIncomplete">;
};

export function isUnresolvedPerson(person: PresenceViewer): boolean {
  return !presenceUserLabel(person).isSharedOwner && !person.name?.trim();
}

function compactPersonLabel(person: PresenceViewer): string {
  return isUnresolvedPerson(person) && !person.id.includes("@") && person.id.length > 8
    ? `${person.id.slice(0, 8)}…`
    : presenceViewerLabel(person);
}

/** Someone with no name or picture: a raw id's first character would say nothing. */
export function UnknownPersonAvatar() {
  return (
    <span
      class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
      aria-hidden="true"
    >
      <Icon name="users" />
    </span>
  );
}

function PersonAvatar(props: {
  person: PresenceViewer | null;
  showPresence?: boolean;
  presentationRevision?: number;
}) {
  const resolvedPerson = () =>
    props.person && !isUnresolvedPerson(props.person) ? props.person : null;
  const activity = createMemo(() => {
    void props.presentationRevision;
    return props.person ? presenceViewerActivity(props.person) : "unknown";
  });
  return (
    <Show when={resolvedPerson()} fallback={<UnknownPersonAvatar />}>
      {(person) => (
        <span class="activity-feed__person-avatar">
          <openclaw-viewer-avatar
            prop:identity={{ type: "profile", id: person().id }}
            prop:user={person()}
            prop:markAsViewer={false}
            variant="footer"
          />
          {props.showPresence && (person().entries?.length ?? 0) > 0 ? (
            <span
              class="activity-feed__presence-dot"
              data-presence-activity={activity()}
              role="img"
              aria-label={(getLocale(), presenceActivityLabel(activity()))}
            />
          ) : undefined}
        </span>
      )}
    </Show>
  );
}

function PersonRow(props: {
  person: ActivityPerson | null;
  view: PeopleView;
  count?: number;
  onSelect: (personId: string | null) => void;
}) {
  const personId = () => props.person?.id ?? null;
  return (
    <button
      type="button"
      class="session-menu__item activity-feed__people-row"
      data-activity-person={personId() ?? ""}
      aria-pressed={props.view.filters.personId === personId() ? "true" : "false"}
      onClick={() => props.onSelect(personId())}
    >
      <PersonAvatar
        person={props.person}
        showPresence
        presentationRevision={props.view.presentationRevision}
      />
      <span class="activity-feed__people-copy">
        <span class="activity-feed__people-name">
          {props.person ? compactPersonLabel(props.person) : t("activityFeed.everyone")}
        </span>
      </span>
      <span class="activity-feed__people-count">{props.count ?? props.person?.count}</span>
    </button>
  );
}

export function PersonFilterChip(props: {
  person: PresenceViewer;
  presentationRevision?: number;
  onClear: () => void;
}) {
  return (
    <div class="activity-feed__applied-filters">
      <span class="activity-feed__person-chip">
        <PersonAvatar person={props.person} presentationRevision={props.presentationRevision} />
        <span class="activity-feed__selected-person">{compactPersonLabel(props.person)}</span>
        <button
          type="button"
          class="activity-feed__people-clear"
          aria-label={t("activityFeed.clearPersonFilter")}
          onClick={() => props.onClear()}
        >
          <Icon name="x" />
        </button>
      </span>
    </div>
  );
}

export function PeopleControl(props: {
  view: PeopleView;
  people: readonly ActivityPerson[];
  selectedPerson: PresenceViewer | null;
  totalSessions: number;
}) {
  let anchor!: HTMLButtonElement;
  let popover: PopoverHandle | undefined;
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;
  const selectPerson = (personId: string | null) => {
    popover?.overlay.request(false, "return");
    props.view.onFiltersChange({ ...props.view.filters, personId });
  };
  const matches = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return props.people.filter((person) =>
      compactPersonLabel(person).toLocaleLowerCase().includes(needle),
    );
  });
  const resolved = createMemo(() => matches().filter((person) => !isUnresolvedPerson(person)));
  const unresolved = createMemo(() => matches().filter(isUnresolvedPerson));
  return (
    <div class="activity-feed__people-control">
      <button
        ref={(node) => {
          anchor = node;
        }}
        id="activity-feed-people-trigger"
        type="button"
        class={[
          "btn btn--sm btn--ghost activity-feed__people-trigger",
          { active: Boolean(props.selectedPerson) },
        ]}
        aria-label={t("activityFeed.peopleButtonLabel")}
        aria-haspopup="dialog"
        aria-controls="activity-feed-people-popover"
        aria-expanded="false"
        onClick={() => popover?.overlay.request(!popover.overlay.open)}
      >
        <Icon name="listFilter" />
      </button>
      <Popover
        id="activity-feed-people-popover"
        ref={(handle) => {
          popover = handle;
        }}
        anchor={anchor}
        label={t("activityFeed.peopleButtonLabel")}
        class="activity-feed__people-popover"
        placement="bottom-end"
        onOpenChange={(open) => {
          if (open) {
            searchInput?.focus({ preventScroll: true });
          } else {
            setQuery("");
          }
        }}
      >
        <div class="activity-feed__people-panel">
          <div class="header-search activity-feed__people-search">
            <Icon name="search" />
            <HeaderSearchField
              label={t("activityFeed.searchPeople")}
              query={query()}
              focus={false}
              inputRef={(element) => {
                searchInput = element;
              }}
              onQueryChange={setQuery}
              onClose={() => popover?.overlay.request(false, "return")}
            />
          </div>
          <div class="activity-feed__people-list">
            <Show when={!query().trim()}>
              <PersonRow
                person={null}
                view={props.view}
                count={props.totalSessions}
                onSelect={selectPerson}
              />
            </Show>
            <For each={resolved()} keyed={(person) => person.id}>
              {(person) => (
                <PersonRow person={person()} view={props.view} onSelect={selectPerson} />
              )}
            </For>
            {unresolved().length > 0 ? (
              <>
                <div class="session-menu__separator" role="separator" />
                <MenuHeading label={t("activityFeed.unresolvedIdentities")} />
                <div data-activity-unresolved>
                  <For each={unresolved()} keyed={(person) => person.id}>
                    {(person) => (
                      <PersonRow person={person()} view={props.view} onSelect={selectPerson} />
                    )}
                  </For>
                </div>
              </>
            ) : undefined}
            <Show when={query().trim() && matches().length === 0}>
              <p class="activity-feed__footer">{t("common.pickerNoMatches")}</p>
            </Show>
          </div>
          {props.view.result?.peopleIncomplete ? (
            <p class="activity-feed__footer" role="status">
              {t("activityFeed.partialHistory")}
            </p>
          ) : undefined}
        </div>
      </Popover>
    </div>
  );
}

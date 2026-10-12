import { createMemo, For, Show } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import {
  presenceActivityLabel,
  presenceViewerActivity,
  presenceViewerLabel,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import type { SessionActivityFilters } from "./session-activity.ts";

type ActivityPerson = PresenceViewer & {
  count: number;
};

type PeopleView = {
  filters: SessionActivityFilters;
  onFiltersChange: (filters: SessionActivityFilters) => void;
  presentationRevision?: number;
  result?: Pick<SessionsListResult, "peopleIncomplete">;
};

function isUnresolvedPerson(person: PresenceViewer): boolean {
  return !person.name && !person.email && presenceViewerLabel(person) === person.id;
}

function compactPersonLabel(person: PresenceViewer): string {
  return isUnresolvedPerson(person) && person.id.length > 8
    ? `${person.id.slice(0, 8)}…`
    : presenceViewerLabel(person);
}

function PersonAvatar(props: {
  person: PresenceViewer | null;
  showPresence?: boolean;
  presentationRevision?: number;
}) {
  const resolvedPerson = createMemo(() =>
    props.person && !isUnresolvedPerson(props.person) ? props.person : null,
  );
  const activity = createMemo(() => {
    void props.presentationRevision;
    return props.person ? presenceViewerActivity(props.person) : "unknown";
  });
  return (
    <Show
      when={resolvedPerson()}
      fallback={
        <span
          class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
          aria-hidden="true"
        >
          <Icon name="users" />
        </span>
      }
    >
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

function selectPerson(event: Event, props: PeopleView, personId: string | null) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.closest("wa-popover")?.removeAttribute("open");
  }
  props.onFiltersChange({ ...props.filters, personId });
}

function setPeopleExpanded(event: Event, expanded: boolean) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.parentElement
      ?.querySelector(".activity-feed__people-trigger")
      ?.setAttribute("aria-expanded", String(expanded));
  }
}

function PersonRow(props: { person: ActivityPerson | null; view: PeopleView; count?: number }) {
  const personId = () => props.person?.id ?? null;
  return (
    <button
      type="button"
      class="session-menu__item activity-feed__people-row"
      data-activity-person={personId() ?? ""}
      aria-pressed={props.view.filters.personId === personId() ? "true" : "false"}
      onClick={(event: Event) => selectPerson(event, props.view, personId())}
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

export function PeopleControl(props: {
  view: PeopleView;
  people: readonly ActivityPerson[];
  selectedPerson: PresenceViewer | null;
  totalSessions: number;
}) {
  const visible = createMemo(() => props.people.slice(0, 3));
  const overflow = () => props.people.length - visible().length;
  const resolved = createMemo(() => props.people.filter((person) => !isUnresolvedPerson(person)));
  const unresolved = createMemo(() => props.people.filter(isUnresolvedPerson));
  return (
    <div class="activity-feed__people-control">
      <button
        id="activity-feed-people-trigger"
        type="button"
        class="btn btn--sm activity-feed__people-trigger"
        aria-label={t("activityFeed.peopleButtonLabel")}
        aria-haspopup="dialog"
        aria-expanded="false"
      >
        {props.selectedPerson ? (
          <>
            <PersonAvatar
              person={props.selectedPerson}
              presentationRevision={props.view.presentationRevision}
            />
            <span class="activity-feed__selected-person">
              {compactPersonLabel(props.selectedPerson)}
            </span>
          </>
        ) : (
          <span class="activity-feed__facepile" aria-hidden="true">
            <For
              each={visible()}
              keyed={(person) => person.id}
              fallback={
                <span class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar">
                  <Icon name="users" />
                </span>
              }
            >
              {(person) => (
                <PersonAvatar
                  person={person()}
                  presentationRevision={props.view.presentationRevision}
                />
              )}
            </For>
            {overflow() > 0 ? (
              <span class="viewer-avatar viewer-avatar--overflow">+{overflow()}</span>
            ) : undefined}
          </span>
        )}
      </button>
      {props.selectedPerson ? (
        <button
          type="button"
          class="btn btn--sm activity-feed__people-clear"
          aria-label={t("activityFeed.clearPersonFilter")}
          onClick={() => props.view.onFiltersChange({ ...props.view.filters, personId: null })}
        >
          <Icon name="x" />
        </button>
      ) : undefined}
      <wa-popover
        ref={syncPopoverLabel}
        class="activity-feed__people-popover"
        for="activity-feed-people-trigger"
        aria-label={t("activityFeed.peopleButtonLabel")}
        placement="bottom-end"
        without-arrow
        onWa-show={(event: Event) => setPeopleExpanded(event, true)}
        onWa-hide={(event: Event) => setPeopleExpanded(event, false)}
      >
        <div class="activity-feed__people-panel">
          <PersonRow person={null} view={props.view} count={props.totalSessions} />
          <For each={resolved()} keyed={(person) => person.id}>
            {(person) => <PersonRow person={person()} view={props.view} />}
          </For>
          {unresolved().length > 0 ? (
            <>
              <div class="session-menu__separator" role="separator" />
              <div class="activity-feed__people-group-label">
                {t("activityFeed.unresolvedIdentities")}
              </div>
              <div data-activity-unresolved>
                <For each={unresolved()} keyed={(person) => person.id}>
                  {(person) => <PersonRow person={person()} view={props.view} />}
                </For>
              </div>
            </>
          ) : undefined}
          {props.view.result?.peopleIncomplete ? (
            <p class="activity-feed__footer" role="status">
              {t("activityFeed.partialHistory")}
            </p>
          ) : undefined}
        </div>
      </wa-popover>
    </div>
  );
}

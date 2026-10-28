import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import {
  presenceViewerActivity,
  type PresenceActivity,
  projectPresenceViewers,
} from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { sidebarPinnedSessionRows } from "./app-sidebar-personal-navigation.ts";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.tsx";
import {
  renderPersonalSessionEmpty,
  renderSessionMutationError,
} from "./app-sidebar-session-filter-summary.tsx";
import type {
  RenderableSessionSection,
  SidebarSessionListHost,
  PersonHeaders,
  SessionCatalogRenderSnapshot,
} from "./app-sidebar-session-render-types.ts";
import {
  renderChildSessionLoadError,
  renderPendingSessionCreateRow,
} from "./app-sidebar-session-row-render.tsx";
import { renderSessionSection as SessionSection } from "./app-sidebar-session-section-render.tsx";
import { PersonalSessionGroups } from "./personal-session-groups.tsx";
import { areSessionCatalogsSettled } from "./session-data-catalog.ts";

function RosterLoadMore(props: {
  host: SidebarSessionListHost;
  hasMore: boolean;
  loading: boolean;
}) {
  return (
    <Show when={props.hasMore}>
      <div class="sidebar-session-pagination sidebar-session-pagination--roster">
        <button
          type="button"
          class="sidebar-session-pagination__button"
          aria-label={
            props.loading ? t("common.loading") : t("chat.selectors.loadMoreRosterSessions")
          }
          disabled={props.loading}
          aria-busy={props.loading ? "true" : "false"}
          onClick={() => void props.host.loadMoreSidebarSessions()}
        >
          {props.loading ? <span class="session-run-spinner" aria-hidden="true" /> : undefined}
          {props.loading ? t("common.loading") : t("chat.selectors.loadMoreRosterSessions")}
        </button>
      </div>
    </Show>
  );
}

function renderSessionListBody(params: Parameters<typeof renderSessionList>[0]) {
  const host = createMemo(() => params.host);
  const personHeaders = createMemo<PersonHeaders | undefined>(() => {
    if (host().sessionsGrouping !== "person") {
      return undefined;
    }
    const selfUser = resolveCurrentSelfUser({
      snapshotUser: host().sessionDataContext?.gateway.snapshot.selfUser,
      presenceEntries: readPresenceEntries(host().sessionData.presencePayload),
      presenceInstanceId: host().sessionData.presenceInstanceId,
    });
    const presence = new Map<string, PresenceActivity>();
    for (const user of projectPresenceViewers(
      host().sessionData.presencePayload,
      selfUser,
      host().sessionData.presenceInstanceId,
    )) {
      if (user.identity?.type === "profile") {
        presence.set(user.identity.id, presenceViewerActivity(user));
      }
    }
    return {
      presence,
      selfProfileId: selfUser?.identity?.type === "profile" ? selfUser.identity.id : undefined,
    };
  });
  const catalogsBySectionId = createMemo(
    () => new Map(params.catalogs.catalogs.map((catalog) => [`catalog:${catalog.id}`, catalog])),
  );
  return (
    <For each={params.sections} keyed={(section) => section.id}>
      {(section) => (
        <Show
          when={section().id.startsWith("catalog:")}
          fallback={
            // Empty personal sections are omitted by the projection. Other empty sections retain their drag destinations.
            <Show
              when={
                !(section().id === "work" && section().totalRowCount === 0) &&
                !(
                  section().id === "ungrouped" &&
                  section().totalRowCount === 0 &&
                  !params.nativeSessionsHaveMore &&
                  !host().sessionOwnershipVisibility.filters &&
                  host().sessionsStatusFilter === "active" &&
                  host().sessionOrganizer.draggingSessionKey === null
                )
              }
            >
              <SessionSection host={host()} section={section()} personHeaders={personHeaders()} />
            </Show>
          }
        >
          <Show when={catalogsBySectionId().get(section().id)}>
            {(catalog) => (
              <params.catalogRenderer
                host={host()}
                snapshot={params.catalogs}
                catalog={catalog()}
              />
            )}
          </Show>
        </Show>
      )}
    </For>
  );
}
export function renderSessionList(params: {
  host: SidebarSessionListHost;
  empty: boolean;
  sections: RenderableSessionSection[];
  nativeSessionsHaveMore: boolean;
  nativeSessionsLoading: boolean;
  catalogs: SessionCatalogRenderSnapshot;
  catalogRenderer: SessionCatalogGroupsRenderer;
}) {
  const host = createMemo(() => params.host);
  // A create for a rendered custom group is placed by that section instead.
  const unplacedCreate = createMemo(() => {
    const pending = host().sessionCreateDisplay();
    const category = pending?.category;
    return category && params.sections.some((section) => section.category === category)
      ? undefined
      : pending;
  });
  return renderSessionListFrame(
    host,
    <div class="sidebar-recent-sessions">
      {renderPendingSessionCreateRow(unplacedCreate)}
      {renderSessionListBody(params)}
      <RosterLoadMore
        host={host()}
        hasMore={params.nativeSessionsHaveMore}
        loading={params.nativeSessionsLoading}
      />
      {renderPersonalSessionEmpty(
        host(),
        params.empty && params.sections.every((section) => section.totalRowCount === 0),
        host().connected &&
          host().sessionData.sessionsResult !== null &&
          !host().sessionData.sessionsLoading &&
          !host().sessionData.sessionMutationError &&
          !params.nativeSessionsHaveMore &&
          params.catalogs.catalogs.length === 0 &&
          areSessionCatalogsSettled(host().sessionData),
      )}
      {host().sessionsStatusFilter === "archived" && params.empty ? (
        <span class="sidebar-session-empty-hint">{t("sessionsView.noArchivedSessions")}</span>
      ) : undefined}
    </div>,
  );
}
/** Personal pins keep their saved order in one section above every list section. */
function PinnedSessionSection(params: { host: SidebarSessionListHost }) {
  const section = createMemo((): RenderableSessionSection | undefined => {
    const host = params.host;
    const zone = host.reconciledSidebarZone();
    const sessions = host.sessionDataContext?.sessions;
    const rows = sidebarPinnedSessionRows(zone, (key) => sessions?.archiveVisibility(key));
    if (rows.length === 0) {
      return undefined;
    }
    const collapsed = host.collapsedSessionSections.has("pinned");
    return {
      id: "pinned",
      rows,
      totalRowCount: rows.length,
      visibleRowCount: collapsed ? 0 : rows.length,
      visibleLimit: rows.length,
      collapsedVisibleRowCount: rows.length,
      renderHeader: true,
    };
  });
  return (
    <Show when={section()}>
      {(pinned) => (
        // The list container owns row insets; chip and roster bodies share this section.
        <div class="sidebar-recent-sessions sidebar-recent-sessions--pinned">
          <SessionSection host={params.host} section={pinned()} personHeaders={undefined} />
        </div>
      )}
    </Show>
  );
}

export function renderSessionListFrame(host: () => SidebarSessionListHost, body: JSX.Element) {
  const home = createMemo(() =>
    host().sidebarAgentsMode === "roster" ? null : host().mainSessionRow(),
  );
  const loadKeys = createMemo(() => {
    const homeValue = home();
    return homeValue
      ? host().projectHomeSession(homeValue, host().expandedAgentId()).childLoadParentKeys
      : [];
  });
  const homeLoadKeys = createMemo(() => {
    const loadKeysValue = loadKeys();
    const homeValue = home();
    return loadKeysValue?.length ? loadKeysValue : homeValue ? [homeValue.key] : [];
  });
  return (
    <section
      class={[
        "sidebar-sessions",
        host().sessionOrganizer.sessionListRemovalDrop && "sidebar-sessions--removal-drop",
      ]}
      onDragOver={(event: DragEvent) => host().sessionOrganizer.handleSessionListDragOver(event)}
      onDragLeave={(event: DragEvent) => host().sessionOrganizer.handleSessionListDragLeave(event)}
      onDrop={(event: DragEvent) => host().sessionOrganizer.handleSessionListDrop(event)}
    >
      {host().sessionData.sessionsStartingUp && !host().sidebarSnapshot ? (
        <div
          class="sidebar-session-empty-hint sidebar-session-empty-hint--startup"
          role="status"
          aria-live="polite"
        >
          <span class="btn__spinner" aria-hidden="true" /> {t("agentStartup.short")}
        </div>
      ) : undefined}
      <For each={homeLoadKeys()}>{(key) => renderChildSessionLoadError(host, key)}</For>
      {host().sessionOrganizer.isDraggingChildSession ? (
        <div class="sidebar-session-root-drop" data-session-root-drop="" role="status">
          {t("sessionsView.moveToTopLevel")}
        </div>
      ) : undefined}
      {renderSessionMutationError(host())}
      <PersonalSessionGroups host={host()} />
      <PinnedSessionSection host={host()} />
      {body}
    </section>
  );
}

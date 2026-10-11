import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, untrack } from "solid-js";
import {
  normalizeSidebarEntries,
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectOnlinePresenceViewers, presenceViewerLabel } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { openPersonalPinnedSession } from "./app-sidebar-personal-navigation.ts";
import {
  renderAppSidebarFooterBar,
  renderAppSidebarPluginTab,
  renderAppSidebarPageEntry,
  type AppSidebarRenderHost,
} from "./app-sidebar-render.tsx";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { renderSidebarReorderMenu } from "./sidebar-reorder.tsx";
import { restoreSnapshotSession } from "./sidebar-snapshot-model.ts";
import { Icon } from "./solid/icon.tsx";
import {
  renderSessionLeadingState,
  renderSessionOwnerAvatar,
} from "./solid/session-presentation.tsx";

type SidebarZone = ReturnType<AppSidebarRenderHost["reconciledSidebarZone"]>;

export function renderSidebarRail(host: AppSidebarRenderHost): JSX.Element {
  const zone = () => host.reconciledSidebarZone();
  const pins = createMemo(() =>
    (normalizeSidebarEntries(host.sidebarSnapshot?.entries ?? host.sidebarEntries) ?? []).map(
      (entry) => parseSidebarEntry(entry)!,
    ),
  );
  const views = ["pages", "sessions", "online"] as const;
  const viewLabel = (view: (typeof views)[number]) =>
    view === "pages"
      ? t("nav.pages")
      : view === "sessions"
        ? titleForRoute("sessions")
        : t("presence.rosterTitle");
  return (
    <nav class="sidebar-rail" aria-label={t("nav.pages")}>
      <div class="sidebar-rail__views">
        <For each={views}>
          {(view) => (
            <openclaw-tooltip prop:content={viewLabel(view)}>
              <button
                type="button"
                class="sidebar-rail__button"
                data-navigation-view={view}
                aria-label={viewLabel(view)}
                aria-pressed={host.navigationView === view ? "true" : "false"}
                onClick={() => {
                  host.navigationView = view;
                  if (view === "online") {
                    host.teamOnlineExpanded = true;
                    if (host.collapsedSessionSections.has("online")) {
                      host.toggleSection("online");
                    }
                  }
                  if (host.navigationCollapsed) {
                    host.onToggleSidebar?.();
                  }
                  host.requestUpdate();
                }}
              >
                <Icon
                  name={
                    view === "pages"
                      ? "layoutGrid"
                      : view === "sessions"
                        ? "messageCircle"
                        : "users"
                  }
                />
              </button>
            </openclaw-tooltip>
          )}
        </For>
      </div>
      <div
        class="sidebar-rail__pins"
        aria-label={t("nav.customize")}
        onDragOver={(event) => host.sessionOrganizer.handleSidebarZoneDragOver(event)}
        onDragLeave={(event) => host.sessionOrganizer.handleSidebarZoneDragLeave(event)}
        onDrop={(event) => host.sessionOrganizer.handleSidebarZoneDrop(event)}
      >
        <For each={pins()} keyed={serializeSidebarEntry}>
          {(entry) => renderRailPin(host, untrack(entry), zone)}
        </For>
      </div>
      <div class="sidebar-rail__bottom">{renderAppSidebarFooterBar(host)}</div>
    </nav>
  );
}

function renderRailPin(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  zone: () => SidebarZone,
): JSX.Element {
  const serialized = serializeSidebarEntry(entry);
  const session = () => (entry.type === "session" ? zone().sessionRows.get(entry.key) : undefined);
  const owner = () =>
    entry.type === "person"
      ? host.sessionOwnerOptions.find(
          (candidate) => candidate.type === "human" && candidate.id === entry.profileId,
        )
      : undefined;
  const online = createMemo(() =>
    entry.type === "person"
      ? (
          host.sidebarSnapshot?.onlineUsers ??
          projectOnlinePresenceViewers(host.sessionData.presencePayload)
        ).find(
          (person) => person.identity?.type === "profile" && person.identity.id === entry.profileId,
        )
      : undefined,
  );
  const plugin = () =>
    entry.type === "plugin"
      ? host.pluginNavigation().find((candidate) => candidate.key === entry.key)
      : undefined;
  const tab = () => (entry.type === "plugin" ? zone().pluginTabs.get(entry.key) : undefined);
  const label = () =>
    entry.type === "route"
      ? titleForRoute(entry.route)
      : entry.type === "person"
        ? owner()?.label || (online() ? presenceViewerLabel(online()!) : t("nav.owner"))
        : session()?.label ||
          plugin()?.value.label ||
          tab()?.label ||
          t(entry.type === "session" ? "sessionsView.openSession" : "tabs.plugin");
  const person = () =>
    entry.type === "person"
      ? personActivityLink(
          entry.profileId,
          personActivityRouting({
            basePath: host.basePath,
            navigate: (route, options) => host.onNavigate?.(route, options),
          }),
        )
      : null;
  const unavailable = (
    <button
      type="button"
      class="sidebar-rail__button"
      aria-label={label()}
      disabled={entry.type !== "session"}
      onClick={() => {
        if (entry.type === "session") {
          void openPersonalPinnedSession(host, entry.key);
        }
      }}
    >
      <Icon name="pin" />
    </button>
  );
  const content =
    entry.type === "person" ? (
      <a
        class="sidebar-rail__button"
        href={person()?.href}
        aria-label={label()}
        onClick={(event) => person()?.open(event)}
      >
        <Show
          when={owner()}
          fallback={
            <Show when={online()} fallback={<Icon name="users" />}>
              {(user) => <openclaw-viewer-avatar prop:user={user()} variant="footer" />}
            </Show>
          }
        >
          {(user) => renderSessionOwnerAvatar(user())}
        </Show>
      </a>
    ) : (
      <Show
        when={session()}
        fallback={
          entry.type === "route" ? (
            <Show when={host.sidebarMenus.isRouteEnabled(entry.route)} fallback={unavailable}>
              {host.sidebarMenus.renderRoute(entry.route)}
            </Show>
          ) : entry.type === "plugin" ? (
            <Show
              when={tab()}
              fallback={
                <Show when={plugin()} fallback={unavailable}>
                  <openclaw-plugin-contributions
                    prop:kind={"navigation"}
                    prop:navigationKey={entry.key}
                    prop:navigationChildren={false}
                    prop:navigationMenus={host.sidebarMenus}
                  />
                </Show>
              }
            >
              {(item) => renderAppSidebarPluginTab(host, item)}
            </Show>
          ) : (
            unavailable
          )
        }
      >
        {(row) => (
          <a
            class="sidebar-rail__button"
            href={host.sidebarSessionHref(row())}
            aria-label={label()}
            aria-current={row().active ? "page" : undefined}
            onClick={(event) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                host.selectSession(row().key, undefined, row());
              }
            }}
          >
            {
              renderSessionLeadingState(
                row(),
                row().owner?.actor,
                "owned",
                undefined,
                undefined,
                false,
                row().icon ? undefined : (
                  <span class="nav-item__icon" aria-hidden="true">
                    <Icon name={row().boardFace === "dashboard" ? "layoutGrid" : "messageCircle"} />
                  </span>
                ),
              ).leadingIndicator
            }
          </a>
        )}
      </Show>
    );
  const drop = () => host.sessionOrganizer.sidebarZoneDropTarget;
  return (
    <div
      class={[
        "sidebar-rail__pin",
        drop()?.entry === serialized ? `sidebar-zone-entry--drop-${drop()?.position}` : undefined,
      ]}
      data-sidebar-entry={serialized}
      draggable={!host.sidebarSnapshot ? "true" : "false"}
      onDragStart={(event) => host.sessionOrganizer.startSidebarEntryDrag(event, entry)}
      onDragEnd={() => host.sessionOrganizer.finishSidebarEntryDrag()}
      onDragOver={(event) => host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
      onDrop={(event) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
    >
      <openclaw-tooltip prop:content={label()}>{content}</openclaw-tooltip>
      <Show when={!host.sidebarSnapshot}>
        {renderSidebarReorderMenu({
          get label() {
            return label();
          },
          kind: "entry",
          onRemove: () => host.sessionOrganizer.removeSidebarEntry(serialized),
          onMove: async (target, position) => {
            host.sessionOrganizer.writeSidebarEntryAt(serialized, target, position);
            await host.updateComplete;
          },
        })}
      </Show>
    </div>
  );
}

/** Pages is the accessible destination catalog, not another favorites list. */
export function renderSidebarPages(host: AppSidebarRenderHost): JSX.Element {
  const zone = () => host.reconciledSidebarZone();
  const dashboards = () => host.navigationCatalog.dashboards;
  const dashboardRows = createMemo(() =>
    host.sidebarSnapshot
      ? host.sidebarSnapshot.pages.map((row) =>
          restoreSnapshotSession(row, host.getRouteSessionKey()),
        )
      : (dashboards()?.result?.sessions ?? []).map((row) =>
          host.getSessionNavigationState().toSidebarSession(row),
        ),
  );
  const rows = createMemo(() => {
    const result = new Map(zone().sessionRows);
    for (const row of dashboardRows()) {
      result.set(row.key, row);
    }
    return result;
  });
  const entries = createMemo(() => {
    const result: SidebarZoneEntry[] = SIDEBAR_NAV_ROUTES.filter((route) =>
      host.sidebarMenus.isRouteEnabled(route),
    ).map((route) => ({ type: "route", route }));
    for (const key of new Set([
      ...zone().pluginTabs.keys(),
      ...host.pluginNavigation().map((entry) => entry.key),
    ])) {
      result.push({ type: "plugin", key });
    }
    for (const row of dashboardRows()) {
      result.push({ type: "session", key: row.key });
    }
    return result;
  });
  return (
    <nav
      class="sidebar-pages"
      aria-label={t("nav.pages")}
      onDragOver={(event) => host.sessionOrganizer.handleSessionListDragOver(event)}
      onDrop={(event) => host.sessionOrganizer.handleSessionListDrop(event)}
    >
      <div class="sidebar-pages__heading">{t("nav.pages")}</div>
      <openclaw-mcp-app-catalog surface="sidebar" />
      <For each={entries()} keyed={serializeSidebarEntry}>
        {(entry) => {
          const fixedEntry = untrack(entry);
          const key = serializeSidebarEntry(fixedEntry);
          return (
            <div class="sidebar-pages__entry">
              {renderAppSidebarPageEntry(host, fixedEntry, rows, () => zone().pluginTabs)}
              <button
                type="button"
                class="sidebar-pages__pin"
                disabled={Boolean(host.sidebarSnapshot)}
                aria-label={t(host.sidebarEntries.includes(key) ? "nav.unpin" : "nav.pin")}
                onClick={() => {
                  if (host.sidebarEntries.includes(key)) {
                    host.sessionOrganizer.removeSidebarEntry(key);
                  } else {
                    host.sessionOrganizer.writeSidebarEntryAt(key, undefined, undefined);
                  }
                }}
              >
                <Icon name="pin" />
              </button>
            </div>
          );
        }}
      </For>
      <Show when={dashboards()?.error}>{(error) => <span role="alert">{error()}</span>}</Show>
      <Show when={dashboards()?.result?.hasMore}>
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => host.navigationCatalog.loadMoreDashboards()}
        >
          {t("chat.selectors.loadMoreSessions")}
        </button>
      </Show>
    </nav>
  );
}

export function renderSidebarScope(host: AppSidebarRenderHost): JSX.Element {
  const allFilter = () => host.sessionOwnerFilter;
  const ownerId = () => (host.sidebarSnapshot ? host.sidebarSnapshot.ownerId : allFilter().ownerId);
  const involvingMe = () => host.sidebarSnapshot?.involvingMe ?? allFilter().involvingMe;
  const selfId = () =>
    host.sidebarSnapshot?.footer?.id ?? host.sessionDataContext?.gateway.snapshot.selfUser?.id;
  const redundant = () =>
    host.sessionsStatusFilter === "active" &&
    (host.sidebarSnapshot?.scopesEquivalent ?? host.navigationCatalog.scopesEquivalent) &&
    !involvingMe() &&
    (!ownerId() || ownerId() === selfId());
  return (
    <Show when={!redundant()}>
      <div class="sidebar-navigation-scope" role="group" aria-label={titleForRoute("sessions")}>
        <For each={["mine", "all"] as const}>
          {(scope) => (
            <openclaw-tooltip prop:content={t(scope === "mine" ? "nav.scopeMine" : "nav.scopeAll")}>
              <button
                type="button"
                class="sidebar-rail__button"
                aria-label={t(scope === "mine" ? "nav.scopeMine" : "nav.scopeAll")}
                aria-pressed={host.effectiveNavigationScope === scope ? "true" : "false"}
                onClick={() => host.setNavigationScope(scope)}
              >
                <Icon name={scope === "mine" ? "target" : "users"} />
              </button>
            </openclaw-tooltip>
          )}
        </For>
      </div>
    </Show>
  );
}

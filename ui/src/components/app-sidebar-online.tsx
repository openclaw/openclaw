import { Dynamic } from "@solidjs/web";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
} from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { showToast } from "../lib/toast.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle.tsx";
import { sidebarOnlineCountFor } from "./sidebar-online-order.ts";
import { resolveSidebarOnline } from "./sidebar-online-state.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "./solid/menu.tsx";
import { Picker } from "./solid/select-picker.tsx";
import { ViewerAvatar } from "./solid/viewer-facepile.tsx";

export function AppSidebarOnline(props: { host: AppSidebarRenderHost }) {
  const host = props.host;
  const sectionId = "online";
  const snapshot = () => host.sidebarSnapshot;
  const online = createMemo(() => resolveSidebarOnline(host));
  const counts = () => online().counts;
  const listUsers = () => online().listUsers;
  const filtered = createMemo(() => host.people.statusFilter === "running");
  const routing = createMemo(() =>
    personActivityRouting(
      { basePath: host.basePath, navigate: (route, options) => host.onNavigate?.(route, options) },
      () => host.dismissTransientMenus(),
    ),
  );
  return (
    <section
      class="sidebar-online"
      aria-label={t("presence.usersTitle")}
      data-session-section={sectionId}
    >
      <div class="sidebar-panel-header" onMouseDown={beginNativeWindowDrag}>
        <Picker
          id="sidebar-people-presence"
          class="sidebar-session-owner-filter"
          triggerIcon="chevronsUpDown"
          label={t("presence.usersTitle")}
          value={host.people.presenceFilter}
          sheet={isMobileNavLayout()}
          showOptionTooltips={false}
          options={[
            { value: "online", label: t("presence.rosterTitle") },
            { value: "all", label: t("presence.allUsers") },
          ]}
          onChange={(value) => {
            if (value === "online" || value === "all") {
              host.people.set("presenceFilter", value);
            }
          }}
        />
        <button
          type="button"
          class={[
            "sidebar-session-toolbar__button sidebar-online__filter-toggle sidebar-session-sort",
            { "sidebar-session-sort--filtered": filtered() },
          ]}
          aria-label={t("presence.filters.label")}
          title={t("presence.filters.label")}
          aria-haspopup="dialog"
          aria-expanded={host.sidebarMenus.peopleFilterMenuPosition !== null ? "true" : "false"}
          onClick={(event: MouseEvent) => {
            if (event.currentTarget instanceof HTMLElement) {
              host.sidebarMenus.togglePositionedMenu("peopleFilter", event.currentTarget);
            }
          }}
        >
          <Icon name="listFilter" />
        </button>
        <SidebarCollapseToggle onToggle={() => host.onToggleSidebar?.()} />
      </div>
      {host.peopleView?.directory()?.loading && (
        <span class="sidebar-session-empty-hint">{t("common.loading")}</span>
      )}
      {Boolean(host.peopleView?.directory()?.error) && (
        <button
          type="button"
          class="sidebar-online__retry"
          onClick={() => void host.peopleView?.directory()?.load(true)}
        >
          {t("presence.directoryFailed")}
        </button>
      )}
      <div class="sidebar-online__list">
        {listUsers().length === 0 ? (
          <span class="sidebar-session-empty-hint">
            {counts() === null
              ? t("presence.sessions.unavailable")
              : t("presence.filters.noMatches")}
          </span>
        ) : undefined}
        <For each={listUsers()} keyed={presenceUserKey}>
          {(readUser) => {
            const user = readUser;
            const activityState = () =>
              user().entries?.length === 0 ? "offline" : presenceViewerActivity(user());
            const workload = () => sidebarOnlineCountFor(counts(), user());
            const workloadLabel = () =>
              workload()
                ? t("presence.sessions.counts", {
                    open: String(workload()!.open),
                    running: String(workload()!.running),
                  })
                : t("presence.sessions.unavailable");
            const activity = createMemo(() =>
              personActivityLink(user().identity?.id, routing(), presenceViewerLabel(user())),
            );
            const menuId = `sidebar-person-${createUniqueId()}`;
            let person: HTMLElement;
            let menu: MenuHandle | undefined;
            const entry = () => `person:${user().identity?.id}`;
            const pinned = () => host.sidebarEntries.includes(entry());
            const openContextMenu = (event: MouseEvent | KeyboardEvent) => {
              const currentMenu = menu;
              if (currentMenu) {
                handleContextMenuEvent(event, person, () => {
                  currentMenu.overlay.setReturnTarget(person);
                  currentMenu.open();
                });
              }
            };
            const items = createMemo((): MenuEntry[] => [
              {
                id: "pin",
                label: t(pinned() ? "presence.menu.unpin" : "presence.menu.pin"),
                icon: <Icon name={pinned() ? "pinOff" : "pin"} />,
                disabled: Boolean(snapshot()),
              },
              {
                kind: "content",
                id: "separator",
                content: <hr class="sidebar-online__menu-separator" />,
              },
              {
                id: "activity",
                label: t("presence.card.viewActivity"),
                icon: <Icon name="activity" />,
                href: activity()?.href,
              },
              {
                id: "new-tab",
                label: t("presence.menu.openNewTab"),
                icon: <Icon name="externalLink" />,
                href: activity()?.href,
                attributes: { target: "_blank", rel: "noopener noreferrer" },
              },
              {
                id: "copy",
                label: t("presence.menu.copyLink"),
                icon: <Icon name="copy" />,
              },
            ]);

            return (
              <div
                class="sidebar-online__row"
                draggable={!snapshot() && user().identity?.type === "profile" ? "true" : "false"}
                onDragStart={(event: DragEvent) => {
                  const identity = user().identity;
                  if (identity?.type === "profile") {
                    host.sessionOrganizer.startSidebarEntryDrag(event, {
                      type: "person",
                      profileId: identity.id,
                    });
                  }
                }}
                onDragEnd={() => host.sessionOrganizer.finishSidebarEntryDrag()}
              >
                <Dynamic
                  ref={(element: HTMLElement) => (person = element)}
                  component={activity() ? "a" : "button"}
                  class="sidebar-online__person"
                  type={activity() ? undefined : "button"}
                  href={activity()?.href ?? undefined}
                  onClick={activity()?.open ?? undefined}
                  onContextMenu={openContextMenu}
                  onKeyDown={openContextMenu}
                  data-person-card
                  data-online-user-id={user().id}
                  data-presence-activity={activityState()}
                  aria-description={`${activityState() === "offline" ? t("presence.offline") : presenceActivityLabel(presenceViewerActivity(user()))} · ${workloadLabel()}`}
                  title={workload() ? undefined : t("presence.sessions.unavailable")}
                  data-person-card-key={presenceUserKey(user())}
                  data-person-card-trigger
                  aria-haspopup="dialog"
                  aria-expanded="false"
                  aria-label={t(activity() ? "presence.card.ariaLabel" : "presence.card.details", {
                    name: presenceViewerLabel(user()),
                  })}
                >
                  <span class="sidebar-online__avatar" aria-hidden="true">
                    <ViewerAvatar user={user()} markAsViewer={false} variant="footer" />
                  </span>
                  <span class="sidebar-online__person-name">{presenceViewerLabel(user())}</span>
                  {workload() && (workload()!.open > 0 || workload()!.running > 0) ? (
                    <span class="sidebar-online__counts" aria-hidden="true">
                      <For each={["running", "open"] as const}>
                        {(kind) => (
                          <Show when={workload()![kind] > 0}>
                            <span
                              class={`sidebar-online__${kind}`}
                              data-session-count={kind}
                              title={t(`presence.sessions.${kind}Count`, {
                                count: String(workload()![kind]),
                              })}
                            >
                              <span
                                class={
                                  kind === "running"
                                    ? "session-run-spinner"
                                    : "sidebar-online__open-icon"
                                }
                              >
                                {kind === "running" ? undefined : <Icon name="messageCircle" />}
                              </span>
                              <span class="sidebar-online__count">{workload()![kind]}</span>
                            </span>
                          </Show>
                        )}
                      </For>
                    </span>
                  ) : undefined}
                </Dynamic>
                {user().identity?.type === "profile" && (
                  <Menu
                    id={menuId}
                    class="sidebar-online__menu"
                    triggerClass="sidebar-online__menu-trigger"
                    label={t("presence.menu.label", { name: presenceViewerLabel(user()) })}
                    trigger={<Icon name="moreHorizontal" />}
                    placement="bottom-end"
                    lazy
                    items={items()}
                    ref={(handle) => (menu = handle)}
                    onBeforeShow={() => host.dismissTransientMenus()}
                    onNavigate={() =>
                      routing().navigate(user().identity!.id, presenceViewerLabel(user()))
                    }
                    onSelect={(item) => {
                      if (item.id === "pin") {
                        if (pinned()) {
                          host.sessionOrganizer.removeSidebarEntry(entry());
                        } else {
                          host.sessionOrganizer.writeSidebarEntryAt(entry(), undefined, undefined);
                        }
                      } else if (item.id === "copy") {
                        void copyToClipboard(
                          new URL(activity()!.href, window.location.href).href,
                        ).then((copied) =>
                          showToast({ message: t(copied ? "common.copied" : "common.copyFailed") }),
                        );
                      }
                    }}
                  />
                )}
              </div>
            );
          }}
        </For>
      </div>
      {host.sessionData.ownerCounts.error ? (
        <button
          type="button"
          class="sidebar-online__retry"
          onClick={() => void host.sessionData.ownerCounts.refresh()}
        >
          {t("presence.sessions.retry")}
        </button>
      ) : undefined}
    </section>
  );
}

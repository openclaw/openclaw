import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { isSessionRouteId } from "../app-route-paths.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { renderPersonalSessionEmpty } from "./app-sidebar-session-filter-summary.tsx";
import {
  renderSessionListFrame,
  renderSessionSection as SessionSection,
} from "./app-sidebar-session-list-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import {
  renderChildSessionLoadError,
  renderPendingSessionCreateRow,
  renderSessionTree as SessionTree,
  renderSidebarSessionIndicators,
} from "./app-sidebar-session-row-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { Menu } from "./solid/menu.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
import {
  TeamSessionSlots,
  type TeamSessionSlotsProps,
  sessionRunVisibility,
} from "./solid/session-presentation.tsx";
import "../styles/sidebar-agent-roster.css";

registerEnglishCatalog(registerAgentsHomeEnglish);
type RosterHost = AppSidebarRenderHost & SessionListHost;
type RosterProps = {
  host: RosterHost;
  active: boolean;
  sections: SidebarVisibleSections["sections"];
  involvingMe: boolean;
  empty: boolean;
};

function cachedRosterCards(host: RosterHost) {
  return host.sidebarSnapshot?.cards.map((card) => ({
    ...card,
    avatar: card.avatar ?? null,
    textAvatar: card.textAvatar ?? null,
    activeNow: false,
    unreadCount: 0,
    lastActiveAt: 0,
    preview: undefined,
    target: sessionNavigationTarget({
      face: "chat",
      sessionKey: card.mainKey,
      fallbackAgentId: card.id,
      basePath: host.basePath,
    }),
  }));
}

function useRoster(props: RosterProps) {
  const application = useApplication();
  const hostProjection = createMemo(() =>
    projectSource(props.host, {
      read: (host) => host,
      subscribe: (host, notify) => host.subscribe(notify),
      equality: "revision",
    }),
  );
  const presented = () => props.active;
  const host = createParkedProjection(() => hostProjection().read(), presented);
  const context = createMemo(() => host().sessionDataContext ?? application);
  const store = createMemo(() => rosterActivityStore(context()));
  const gateway = createMemo(() => projectGateway(context().gateway));
  const snapshot = createParkedProjection(() => {
    host();
    return store().snapshot;
  }, presented);
  const cached = createMemo(() => cachedRosterCards(host()));
  const cards = createParkedProjection(() => {
    if (cached()) {
      return cached()!;
    }
    const currentContext = context();
    return snapshot().cards.map((card) =>
      Object.assign({}, card, {
        target: sessionNavigationTarget({
          context: currentContext,
          face: "chat",
          sessionKey: card.mainKey,
          agentId: card.id,
        }),
      }),
    );
  }, presented);
  return { host, context, store, snapshot, gateway, cards };
}

export function SidebarAgentRoster(props: RosterProps) {
  const roster = useRoster(props);
  const presented = () => props.active;
  const parkedSections = createParkedProjection(() => props.sections, presented);
  const empty = createParkedProjection(() => props.empty, presented);
  const gatewaySnapshot = createParkedProjection(() => roster.gateway().read(), presented);
  const settingsScope = createMemo(() => gatewaySnapshot().connection.gatewayUrl);
  // Restore saved choices only when the Gateway scope changes, retaining local toggles otherwise.
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(() => {
    const gatewayUrl = settingsScope();
    return new Set(
      untrack(() => props.host.sidebarSnapshot?.collapsedAgentIds) ??
        loadSettings(gatewayUrl).sidebarCollapsedAgentIds ??
        [],
    );
  });
  createEffect(
    () => [roster.store(), props.involvingMe] as const,
    ([store, involvingMe]) => {
      store.setInvolvingMe(involvingMe);
    },
  );
  createEffect(roster.store, (store) => () => store.setInvolvingMe(false));
  // Sidebar queries keep the last admitted selection while the roster is parked.
  const queryCollapsed = createMemo<ReadonlySet<string> | null>((previous) =>
    presented() ? collapsed() : (previous ?? null),
  );
  // Owner publications must not tear down the query accessor on the same host.
  const hostIdentity = createMemo(() => props.host);
  // The synchronous owner publishes through its own frame, not this child's dependencies.
  const readCollapsed = () => untrack(queryCollapsed);
  createEffect(hostIdentity, (host) => {
    host.readRosterCollapsedAgentIds = readCollapsed;
    return () => {
      if (host.readRosterCollapsedAgentIds === readCollapsed) {
        host.readRosterCollapsedAgentIds = null;
        host.requestUpdate();
      }
    };
  });
  createEffect(
    () => [hostIdentity(), queryCollapsed()] as const,
    ([host, ids]) => {
      if (ids) {
        host.sessionData.requestSessionDataUpdate();
      }
    },
  );
  const setCollapsedAgents = (next: ReadonlySet<string>) => {
    patchSettings(
      {
        gatewayUrl: settingsScope(),
        sidebarCollapsedAgentIds: [...next],
      },
      { selectGateway: false },
    );
    setCollapsed(next);
  };
  const toggleAgent = (id: string) => {
    const next = new Set(collapsed());
    if (!next.delete(id)) {
      next.add(id);
    }
    setCollapsedAgents(next);
  };
  const error = () => roster.snapshot().error ?? roster.snapshot().subscriptionError;
  return (
    <openclaw-sidebar-agent-roster>
      {renderSessionListFrame(
        untrack(roster.host),
        <div class="sidebar-agent-roster">
          <Show when={error()}>
            <button
              class="sidebar-agent-roster__link"
              onClick={() => void roster.store().refresh()}
            >
              {t("agentsHome.loadFailed")}
            </button>
          </Show>
          <Show when={roster.snapshot().loading && roster.cards().length === 0}>
            <span role="status" aria-label={t("common.loading")} class="skeleton skeleton-line" />
          </Show>
          <For each={roster.cards()} keyed={(card) => card.id}>
            {(card) => {
              const runVisibility = sessionRunVisibility;
              const sections = () =>
                parkedSections().filter((section) => section.id.startsWith(`agent:${card().id}:`));
              const mainKey = () => roster.host().selectedAgentMainSessionKey(card().id);
              const mainRow = () => roster.host().mainSessionRow(card().id);
              const home = () => {
                const row = mainRow();
                return row ? roster.host().projectHomeSession(row, card().id) : null;
              };
              const homeLoadKeys = () =>
                home()?.childLoadParentKeys?.length
                  ? home()!.childLoadParentKeys!
                  : [mainRow()?.key ?? mainKey()];
              const main = createParkedProjection(
                () => roster.host().visibleHomeSession(card().id),
                presented,
              );
              const isCollapsed = () => collapsed().has(card().id);
              const hasSessions = () =>
                sections().some((section) => section.rows.length > 0) ||
                home()?.loadingChildren ||
                homeLoadKeys().some((key) =>
                  roster.host().sessionData.childSessionErrorsByParent.has(key),
                ) ||
                home()?.childLoadParentKeys?.some(
                  (key) => !roster.host().sessionData.loadedChildSessionKeys.has(key),
                );
              const active = () =>
                isSessionRouteId(roster.host().activeRouteId) &&
                areUiSessionKeysEquivalent(roster.host().getRouteSessionKey(), mainKey());
              const summaryRows = () => [
                ...(main() ? [main()!] : []),
                ...(isCollapsed() ? sections().flatMap((section) => section.rows) : []),
              ];
              const headerSummary = (): TeamSessionSlotsProps => ({
                rows: summaryRows(),
                includeChildren: isCollapsed(),
                childCount: isCollapsed()
                  ? sections().reduce((count, section) => count + section.rows.length, 0)
                  : 0,
                groupConflicts: summaryRows().reduce(
                  (count, row) => count + (row.workspaceConflictCount ?? 0),
                  0,
                ),
                runVisibility,
              });
              const access = () => roster.host().readNewSessionAccess();
              const collapseLabel = () =>
                t(isCollapsed() ? "agentsHome.expandAgent" : "agentsHome.collapseAgent", {
                  agent: card().name,
                });
              return (
                <section
                  class="sidebar-agent-roster__group"
                  data-agent-group={card().id}
                  aria-label={card().name}
                >
                  <div
                    class={[
                      "sidebar-agent-roster__header session-row-host",
                      { "sidebar-agent-roster__header--current": active() },
                    ]}
                  >
                    {/* The avatar doubles as the collapse toggle (it shows a chevron on
                        hover/focus), so the header needs no separate disclosure column. */}
                    <Show
                      when={hasSessions()}
                      fallback={
                        <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                          <AgentIdentityAvatar agent={card()} />
                        </span>
                      }
                    >
                      <button
                        type="button"
                        class="sidebar-agent-roster__toggle"
                        data-agent-collapse={card().id}
                        aria-label={collapseLabel()}
                        title={collapseLabel()}
                        aria-expanded={isCollapsed() ? "false" : "true"}
                        onClick={() => toggleAgent(card().id)}
                      >
                        <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                          <AgentIdentityAvatar agent={card()} />
                        </span>
                        <span class="sidebar-agent-roster__chevron" aria-hidden="true">
                          <Icon name={isCollapsed() ? "chevronRight" : "chevronDown"} />
                        </span>
                      </button>
                    </Show>
                    <a
                      class="sidebar-agent-roster__row"
                      data-agent-id={card().id}
                      href={card().target.href}
                      aria-current={active() ? "page" : undefined}
                      title={t("agentsHome.openChat")}
                      onClick={(event: MouseEvent) => {
                        if (shouldHandleNavigationClick(event)) {
                          event.preventDefault();
                          roster.host().openMainSession(card().id);
                        }
                      }}
                    >
                      <span class="sidebar-agent-roster__copy">
                        <span>{card().name}</span>
                      </span>
                    </a>
                    <span class="sidebar-agent-roster__signals">
                      <Show when={main()} fallback={<TeamSessionSlots {...headerSummary()} />}>
                        {(session) =>
                          renderSidebarSessionIndicators(
                            untrack(roster.host),
                            session,
                            undefined,
                            undefined,
                            headerSummary,
                          ).content
                        }
                      </Show>
                    </span>
                    <span
                      class="sidebar-agent-roster__actions"
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === " " && event.target instanceof HTMLAnchorElement) {
                          event.preventDefault();
                          event.target.click();
                        }
                      }}
                    >
                      {renderNewSessionLink({
                        get basePath() {
                          return roster.host().basePath;
                        },
                        get agentId() {
                          return card().id;
                        },
                        class: "sidebar-agent-roster__action sidebar-agent-roster__new",
                        get label() {
                          return `${t("agentChip.newConversation")}: ${card().name}`;
                        },
                        get disabledReason() {
                          const currentAccess = access();
                          return currentAccess.allowed ? undefined : currentAccess.reason;
                        },
                        onOpen: (id, target) => roster.host().requestOpenNewSession(id, target),
                      })}
                      <Menu
                        id={`sidebar-agent-roster-${card().id}`}
                        class="sidebar-customize-menu sidebar-agent-roster__menu"
                        placement="bottom-end"
                        label={t("agentsHome.agentOptions", { agent: card().name })}
                        triggerClass="sidebar-agent-roster__action"
                        trigger={<Icon name="moreHorizontal" />}
                        lazy
                        ref={({ overlay }) => {
                          overlay.surface.dataset.chatAutotypeExempt = "";
                        }}
                        onBeforeShow={() => {
                          roster.host().dismissTransientMenus();
                        }}
                        onSelect={(item) => {
                          switch (item.id) {
                            case "main":
                              roster.host().openMainSession(card().id);
                              break;
                            case "sessions":
                              roster.context().agentSelection.setScope(card().id);
                              roster.host().onNavigate?.("sessions");
                              break;
                            case "collapse-others":
                              setCollapsedAgents(
                                new Set(
                                  roster
                                    .cards()
                                    .filter((other) => other.id !== card().id)
                                    .map((other) => other.id),
                                ),
                              );
                              break;
                          }
                        }}
                        items={[
                          {
                            id: "main",
                            label: t("agentsHome.openMainChat"),
                            class: "sidebar-customize-menu__item",
                            icon: <Icon name="messageSquare" />,
                          },
                          {
                            id: "sessions",
                            label: t("agentsHome.allSessions"),
                            class: "sidebar-customize-menu__item",
                            icon: <Icon name="listTree" />,
                          },
                          {
                            id: "collapse-others",
                            label: t("agentsHome.collapseOthers"),
                            class: "sidebar-customize-menu__item",
                            icon: <Icon name="foldVertical" />,
                          },
                        ]}
                      />
                    </span>
                  </div>
                  <Show when={!isCollapsed()}>
                    {renderPendingSessionCreateRow(roster.host, card().id)}
                    <For each={homeLoadKeys()}>
                      {(key) => renderChildSessionLoadError(roster.host(), key)}
                    </For>
                    <For each={sections()} keyed={(section) => section.id}>
                      {(section) => (
                        <SessionSection
                          host={roster.host()}
                          section={section()}
                          personHeaders={undefined}
                        />
                      )}
                    </For>
                  </Show>
                </section>
              );
            }}
          </For>
          {renderPersonalSessionEmpty(
            roster.host(),
            empty(),
            gatewaySnapshot().snapshot.phase === "connected" &&
              roster.snapshot().result !== null &&
              !roster.snapshot().loading &&
              !error() &&
              !roster.snapshot().result!.hasMore &&
              !roster.host().sessionData.sessionMutationError,
          )}
        </div>,
      )}
    </openclaw-sidebar-agent-roster>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-agent-roster": HTMLAttributes<HTMLElement>;
    }
  }
}

export function renderSidebarPinnedSession(host: RosterHost, session: () => SidebarRecentSession) {
  const agentId = createMemo(() => host.sessionNavigationAgentId(session()));
  const card = createMemo(() => {
    const cards =
      cachedRosterCards(host) ??
      (host.sessionDataContext ? rosterActivityStore(host.sessionDataContext).snapshot.cards : []);
    return cards.find((agent) => agent.id === agentId());
  });
  return (
    <SessionTree
      host={host}
      session={session()}
      listItem={false}
      icon={<AgentIdentityAvatar agent={card() ?? { id: agentId() }} />}
    />
  );
}

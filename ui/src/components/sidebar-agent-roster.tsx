import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { isSessionRouteId } from "../app-route-paths.ts";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../lib/reactive/projection.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import {
  renderSessionListFrame,
  renderSessionSection as SessionSection,
} from "./app-sidebar-session-list-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import {
  renderChildSessionLoadError,
  renderSessionTree as SessionTree,
  renderSidebarSessionIndicators,
} from "./app-sidebar-session-row-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { SidebarPinnedAgent } from "./sidebar-pinned-agent.tsx";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { Menu } from "./solid/menu.tsx";
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
    assistantPreview: undefined,
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
  const gatewaySnapshot = createParkedProjection(() => roster.gateway().read(), presented);
  const navigation = createMemo(() =>
    projectOwner(roster.context().navigation, (owner) => owner.snapshot),
  );
  const pinnedIds = createParkedProjection(
    () => new Set(navigation().read().pinnedAgentIds),
    presented,
  );
  const pinnedCards = () => roster.cards().filter((card) => pinnedIds().has(card.id));
  const unpinnedCards = () => roster.cards().filter((card) => !pinnedIds().has(card.id));
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
  // Admit deletes synchronously while Solid publishes their pending presentation.
  const pendingDeletes = new Set<string>();
  const [deletingIds, publishDeletingIds] = createSignal<ReadonlySet<string>>(pendingDeletes, {
    equals: false,
  });
  const deleting = (id: string) => deletingIds().has(id);
  const canDeleteAgent = (id: string) =>
    !pendingDeletes.has(id) &&
    (roster.context().agents.state.agentsList?.agents.filter((agent) => agent.kind !== "system")
      .length ?? 0) > 1 &&
    canCallGatewayMethod(roster.context().gateway.snapshot, "agents.delete", "operator.admin") &&
    roster.cards().some((agent) => agent.id === id);
  const deleteAgent = async (agent: { id: string; name: string }) => {
    const context = roster.context();
    const client = context.gateway.snapshot.client;
    if (!client || !canDeleteAgent(agent.id)) {
      return;
    }
    const confirmed = await showConfirmDialog({
      message: t("agentsHome.deleteAgentConfirm", { agent: agent.name }),
      details: t("agentsHome.deleteAgentDetails"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed || context.gateway.snapshot.client !== client || !canDeleteAgent(agent.id)) {
      return;
    }
    pendingDeletes.add(agent.id);
    publishDeletingIds(pendingDeletes);
    try {
      await client.request("agents.delete", { agentId: agent.id, deleteFiles: true });
    } catch (error) {
      showToast({ message: formatUiError(error) });
    } finally {
      await context.agents.refreshList();
      pendingDeletes.delete(agent.id);
      publishDeletingIds(pendingDeletes);
    }
  };
  const agentMenu = (card: () => { id: string; name: string }) => (
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
          case "pin": {
            const id = card().id;
            togglePinnedAgent(roster.context().navigation, id);
            // Pinning replaces the menu trigger; keep keyboard focus on its agent.
            onSettled(() => {
              const selector = `[data-agent-id="${CSS.escape(id)}"]`;
              roster.host().querySelector<HTMLElement>(selector)?.focus();
            });
            break;
          }
          case "new-session":
            roster.host().requestOpenNewSession(card().id);
            break;
          case "sessions":
            roster.context().agentSelection.setScope(card().id);
            roster.host().onNavigate?.("sessions");
            break;
          case "delete":
            void deleteAgent(card());
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
          id: "pin",
          label: t(pinnedIds().has(card().id) ? "nav.unpin" : "nav.pin"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="pin" />,
        },
        {
          id: "new-session",
          label: t("agentsHome.createNewSession"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="plus" />,
          disabled: !roster.host().readNewSessionAccess().allowed,
        },
        {
          id: "sessions",
          label: t("agentsHome.viewSessions"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="listTree" />,
        },
        {
          id: "collapse-others",
          label: t("agentsHome.collapseOthers"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="foldVertical" />,
        },
        {
          id: "delete",
          label: t(deleting(card().id) ? "agentsHome.deletingAgent" : "common.delete"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="trash" />,
          variant: "danger",
          disabled: deleting(card().id) || !canDeleteAgent(card().id),
        },
      ]}
    />
  );
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
          <Show when={pinnedCards().length > 0}>
            <section class="sidebar-pinned-agents" aria-label={t("agentsHome.pinnedAgents")}>
              <For each={pinnedCards()} keyed={(card) => card.id}>
                {(card) => (
                  <SidebarPinnedAgent
                    agent={card()}
                    href={card().target.href}
                    loading={roster.snapshot().loading}
                    deleting={deleting(card().id)}
                    active={
                      isSessionRouteId(roster.host().activeRouteId) &&
                      areUiSessionKeysEquivalent(roster.host().getRouteSessionKey(), card().mainKey)
                    }
                    onOpen={() => roster.host().openMainSession(card().id)}
                    menu={agentMenu(card)}
                  />
                )}
              </For>
            </section>
          </Show>
          <For each={unpinnedCards()} keyed={(card) => card.id}>
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
              const collapseLabel = () =>
                t(isCollapsed() ? "agentsHome.expandAgent" : "agentsHome.collapseAgent", {
                  agent: card().name,
                });
              return (
                <section
                  class="sidebar-agent-roster__group"
                  data-agent-group={card().id}
                  aria-label={card().name}
                  aria-busy={deleting(card().id) ? "true" : undefined}
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
                      onClick={(event: MouseEvent) => {
                        if (shouldHandleNavigationClick(event)) {
                          event.preventDefault();
                          roster.host().openMainSession(card().id);
                        }
                      }}
                    >
                      <span class="sidebar-agent-roster__copy">
                        <span class="sidebar-agent-roster__name">{card().name}</span>
                        <Show when={deleting(card().id) || card().assistantPreview}>
                          <span
                            class="sidebar-agent-roster__preview"
                            role={deleting(card().id) ? "status" : undefined}
                          >
                            {deleting(card().id)
                              ? t("agentsHome.deletingAgent")
                              : card().assistantPreview}
                          </span>
                        </Show>
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
                    <span class="sidebar-agent-roster__actions">{agentMenu(card)}</span>
                  </div>
                  <Show when={!isCollapsed()}>
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

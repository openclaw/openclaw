import { createEffect, createMemo, For, onSettled, Show, untrack } from "solid-js";
import { isSessionRouteId, pathForAgentPanel } from "../app-route-paths.ts";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../lib/reactive/projection.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { renderSessionListFrame } from "./app-sidebar-session-list-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import {
  renderPendingSessionCreateRow,
  renderSessionTree as SessionTree,
} from "./app-sidebar-session-row-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { SidebarPinnedAgent } from "./sidebar-pinned-agent.tsx";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { Menu } from "./solid/menu.tsx";
import {
  SessionGlyph,
  TeamSessionSlots,
  sessionRunVisibility,
  type TeamSessionSlotsProps,
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
    sessionCount: 0,
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
  return { host, context, store, snapshot, cards };
}

export function SidebarAgentRoster(props: RosterProps) {
  const roster = useRoster(props);
  const presented = () => props.active;
  const parkedSections = createParkedProjection(() => props.sections, presented);
  const navigation = createMemo(() =>
    projectOwner(roster.context().navigation, (owner) => owner.snapshot),
  );
  const pinnedIds = createParkedProjection(
    () => new Set(navigation().read().pinnedAgentIds),
    presented,
  );
  const pinnedCards = () => roster.cards().filter((card) => pinnedIds().has(card.id));
  const unpinnedCards = () => roster.cards().filter((card) => !pinnedIds().has(card.id));
  const hiddenAgentSections = createMemo<ReadonlySet<string>>((previous) => {
    const next = new Set(roster.cards().map((card) => card.id));
    if (previous?.size === next.size && [...next].every((id) => previous.has(id))) {
      return previous;
    }
    return next;
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
    presented() ? hiddenAgentSections() : (previous ?? null),
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
  const canDeleteAgent = (id: string) =>
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
    try {
      await client.request("agents.delete", { agentId: agent.id, deleteFiles: true });
    } catch (error) {
      showToast({ message: formatUiError(error) });
    } finally {
      await context.agents.refreshList();
    }
  };
  const agentMenu = (card: () => { id: string; name: string; sessionCount: number }) => (
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
          case "sessions":
            roster.context().agentSelection.setScope(card().id);
            roster.host().onNavigate?.("sessions");
            break;
          case "settings":
            roster.context().navigate("agents", {
              pathname: pathForAgentPanel(card().id, null, roster.context().basePath),
            });
            break;
          case "delete":
            void deleteAgent(card());
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
          id: "sessions",
          label: t("agentsHome.viewSessions"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="listTree" />,
        },
        {
          id: "settings",
          label: t("nav.settings"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="settings" />,
        },
        {
          id: "delete",
          label: t("common.delete"),
          class: "sidebar-customize-menu__item",
          icon: <Icon name="trash" />,
          variant: "danger",
          disabled: !canDeleteAgent(card().id),
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
            <>
              <section class="sidebar-pinned-agents" aria-label={t("agentsHome.pinnedAgents")}>
                <For each={pinnedCards()} keyed={(card) => card.id}>
                  {(card) => (
                    <SidebarPinnedAgent
                      agent={card()}
                      href={card().target.href}
                      loading={roster.snapshot().loading}
                      active={
                        isSessionRouteId(roster.host().activeRouteId) &&
                        areUiSessionKeysEquivalent(
                          roster.host().getRouteSessionKey(),
                          card().mainKey,
                        )
                      }
                      onOpen={() => roster.host().openMainSession(card().id)}
                      menu={agentMenu(card)}
                    />
                  )}
                </For>
              </section>
              <For each={pinnedCards()} keyed={(card) => card.id}>
                {(card) =>
                  renderPendingSessionCreateRow(
                    roster.host,
                    untrack(() => card().id),
                  )
                }
              </For>
            </>
          </Show>
          <For each={unpinnedCards()} keyed={(card) => card.id}>
            {(card) => {
              const mainKey = () => roster.host().selectedAgentMainSessionKey(card().id);
              const sections = () =>
                parkedSections().filter((section) => section.id.startsWith(`agent:${card().id}:`));
              const main = createParkedProjection(
                () => roster.host().visibleHomeSession(card().id),
                presented,
              );
              const summaryRows = () => [
                ...(main() ? [main()!] : []),
                ...sections().flatMap((section) => section.rows),
              ];
              const headerSummary = (): TeamSessionSlotsProps => ({
                rows: summaryRows(),
                includeChildren: true,
                childCount: 0,
                groupConflicts: summaryRows().reduce(
                  (count, row) => count + (row.workspaceConflictCount ?? 0),
                  0,
                ),
                statusOnly: true,
              });
              const active = () =>
                isSessionRouteId(roster.host().activeRouteId) &&
                areUiSessionKeysEquivalent(roster.host().getRouteSessionKey(), mainKey());
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
                      <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                        <SessionGlyph
                          circular
                          content={<AgentIdentityAvatar agent={card()} />}
                          running={card().activeNow}
                          runVisibility={sessionRunVisibility}
                        />
                      </span>
                      <span class="sidebar-agent-roster__copy">
                        <span class="sidebar-agent-roster__name">{card().name}</span>
                        <Show when={card().assistantPreview}>
                          <span class="sidebar-agent-roster__preview">
                            {card().assistantPreview}
                          </span>
                        </Show>
                        <Show when={card().activeNow}>
                          <span class="sr-only">{t("agentsHome.working")}</span>
                        </Show>
                      </span>
                    </a>
                    <span class="sidebar-agent-roster__signals">
                      <TeamSessionSlots {...headerSummary()} />
                    </span>
                    <span class="sidebar-agent-roster__actions">{agentMenu(card)}</span>
                  </div>
                  {renderPendingSessionCreateRow(roster.host, card().id)}
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

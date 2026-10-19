import { createMemo, For, onCleanup, onSettled, Show, untrack } from "solid-js";
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
import { projectOwner } from "../lib/reactive/projection.ts";
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
import "../styles/sidebar-pinned-agents.css";
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

export function SidebarAgentRoster(props: RosterProps) {
  const context = useApplication();
  const hostProjection = createMemo(() => projectOwner(props.host, (host) => host));
  const presented = () => props.active;
  const host = createParkedProjection(() => hostProjection().read(), presented);
  const store = rosterActivityStore(context);
  const snapshot = createParkedProjection(() => {
    host();
    return store.snapshot;
  }, presented);
  const cached = createMemo(() => cachedRosterCards(host()));
  const cards = createParkedProjection(() => {
    if (cached()) {
      return cached()!;
    }
    return snapshot().cards.map((card) =>
      Object.assign({}, card, {
        target: sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: card.mainKey,
          agentId: card.id,
        }),
      }),
    );
  }, presented);
  const agentLinks = new Map<string, HTMLAnchorElement>();
  const createAgentLinkRef = (card: () => { id: string }) => {
    // The keyed row keeps this identity until its branch is removed.
    const id = card().id;
    let link: HTMLAnchorElement | undefined;
    onCleanup(() => {
      if (agentLinks.get(id) === link) {
        agentLinks.delete(id);
      }
    });
    return (element: HTMLAnchorElement) => {
      link = element;
      agentLinks.set(id, element);
    };
  };
  const parkedSections = createParkedProjection(() => props.sections, presented);
  const navigation = createMemo(() => projectOwner(context.navigation, (owner) => owner.snapshot));
  const pinnedIds = createParkedProjection(
    () => new Set(navigation().read().pinnedAgentIds),
    presented,
  );
  const pinnedCards = () => cards().filter((card) => pinnedIds().has(card.id));
  const unpinnedCards = () => cards().filter((card) => !pinnedIds().has(card.id));
  const canDeleteAgent = (id: string) =>
    (context.agents.state.agentsList?.agents.filter((agent) => agent.kind !== "system").length ??
      0) > 1 &&
    canCallGatewayMethod(context.gateway.snapshot, "agents.delete", "operator.admin") &&
    cards().some((agent) => agent.id === id);
  const deleteAgent = async (agent: { id: string; name: string }) => {
    const currentContext = context;
    const client = currentContext.gateway.snapshot.client;
    if (!client || !canDeleteAgent(agent.id)) {
      return;
    }
    const confirmed = await showConfirmDialog({
      message: t("agentsHome.deleteAgentConfirm", { agent: agent.name }),
      details: t("agentsHome.deleteAgentDetails"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (
      !confirmed ||
      currentContext.gateway.snapshot.client !== client ||
      !canDeleteAgent(agent.id)
    ) {
      return;
    }
    try {
      await client.request("agents.delete", { agentId: agent.id, deleteFiles: true });
    } catch (error) {
      showToast({ message: formatUiError(error) });
    } finally {
      await currentContext.agents.refreshList();
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
        host().dismissTransientMenus();
      }}
      onSelect={(item) => {
        switch (item.id) {
          case "pin": {
            const id = card().id;
            togglePinnedAgent(context.navigation, id);
            // Pinning replaces the menu trigger; keep keyboard focus on its agent.
            onSettled(() => agentLinks.get(id)?.focus());
            break;
          }
          case "sessions":
            context.agentSelection.setScope(card().id);
            host().onNavigate?.("sessions");
            break;
          case "settings":
            context.navigate("agents", {
              pathname: pathForAgentPanel(card().id, null, context.basePath),
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
  const error = () => snapshot().error ?? snapshot().subscriptionError;
  return (
    <openclaw-sidebar-agent-roster>
      {renderSessionListFrame(
        host,
        <div class="sidebar-agent-roster">
          <Show when={error()}>
            <button class="sidebar-agent-roster__link" onClick={() => void store.refresh()}>
              {t("agentsHome.loadFailed")}
            </button>
          </Show>
          <Show when={snapshot().loading && cards().length === 0}>
            <span role="status" aria-label={t("common.loading")} class="skeleton skeleton-line" />
          </Show>
          <Show when={pinnedCards().length > 0}>
            <>
              <section class="sidebar-pinned-agents" aria-label={t("agentsHome.pinnedAgents")}>
                <For each={pinnedCards()} keyed={(card) => card.id}>
                  {(card) => {
                    const linkRef = createAgentLinkRef(card);
                    const active = () =>
                      isSessionRouteId(host().activeRouteId) &&
                      areUiSessionKeysEquivalent(host().getRouteSessionKey(), card().mainKey);
                    return (
                      <div
                        class="sidebar-pinned-agent session-row-host"
                        data-pinned-agent={card().id}
                      >
                        <openclaw-tooltip
                          class="sidebar-pinned-agent__tooltip"
                          prop:placement="right-start"
                        >
                          <a
                            ref={linkRef}
                            class="sidebar-pinned-agent__link"
                            data-agent-id={card().id}
                            href={card().target.href}
                            aria-label={card().name}
                            aria-current={active() ? "page" : undefined}
                            onClick={(event: MouseEvent) => {
                              if (shouldHandleNavigationClick(event)) {
                                event.preventDefault();
                                host().openMainSession(card().id);
                              }
                            }}
                          >
                            <span class="sidebar-pinned-agent__avatar" aria-hidden="true">
                              <SessionGlyph
                                circular
                                content={<AgentIdentityAvatar agent={card()} />}
                                running={card().activeNow}
                                runVisibility={sessionRunVisibility}
                              />
                            </span>
                            <span class="sidebar-pinned-agent__name">{card().name}</span>
                          </a>
                          <span slot="content" class="sidebar-pinned-agent__card">
                            <span class="sidebar-pinned-agent__card-header">
                              <span class="sidebar-pinned-agent__avatar" aria-hidden="true">
                                <AgentIdentityAvatar agent={card()} />
                              </span>
                              <span>{card().name}</span>
                            </span>
                            <span class="sidebar-pinned-agent__preview">
                              {card().assistantPreview ||
                                t(
                                  snapshot().loading
                                    ? "common.loading"
                                    : "agentsHome.noAssistantMessage",
                                )}
                            </span>
                          </span>
                        </openclaw-tooltip>
                        {agentMenu(card)}
                      </div>
                    );
                  }}
                </For>
              </section>
              <For each={pinnedCards()} keyed={(card) => card.id}>
                {(card) => {
                  const initialAgentId = untrack(() => card().id);
                  return renderPendingSessionCreateRow(host, initialAgentId);
                }}
              </For>
            </>
          </Show>
          <For each={unpinnedCards()} keyed={(card) => card.id}>
            {(card) => {
              const linkRef = createAgentLinkRef(card);
              const mainKey = () => host().selectedAgentMainSessionKey(card().id);
              const sections = () =>
                parkedSections().filter((section) => section.id.startsWith(`agent:${card().id}:`));
              const main = createParkedProjection(
                () => host().visibleHomeSession(card().id),
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
                isSessionRouteId(host().activeRouteId) &&
                areUiSessionKeysEquivalent(host().getRouteSessionKey(), mainKey());
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
                      ref={linkRef}
                      class="sidebar-agent-roster__row"
                      data-agent-id={card().id}
                      href={card().target.href}
                      aria-current={active() ? "page" : undefined}
                      onClick={(event: MouseEvent) => {
                        if (shouldHandleNavigationClick(event)) {
                          event.preventDefault();
                          host().openMainSession(card().id);
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
                  {renderPendingSessionCreateRow(host, card().id)}
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

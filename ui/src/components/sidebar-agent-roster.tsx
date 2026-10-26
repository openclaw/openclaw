import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { isSessionRouteId, pathForAgentPanel } from "../app-route-paths.ts";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { clawCreatorAction } from "../pages/claws/creator-flow.ts";
import { canCreateClawDraft } from "../pages/claws/draft-navigation.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { renderSessionListFrame } from "./app-sidebar-session-list-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { renderSessionTree as SessionTree } from "./app-sidebar-session-row-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import "../styles/sidebar-pinned-agents.css";
import { createSidebarRosterWindow } from "./sidebar-roster-window.tsx";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import { Menu, type MenuEntry } from "./solid/menu.tsx";
import {
  SessionGlyph,
  TeamSessionSlots,
  sessionRunVisibility,
  type TeamSessionSlotsProps,
} from "./solid/session-presentation.tsx";
import "../styles/sidebar-agent-roster.css";

registerEnglishCatalog(registerAgentsHomeEnglish);
type RosterHost = AppSidebarRenderHost & SessionListHost;
type AgentMenuCard = { id: string; name: string };
type AgentContextMenu = { id: string; x: number; y: number; anchor: HTMLElement | null };

function cachedRosterCards(host: RosterHost) {
  return host.sidebarSnapshot?.cards.map((card) => ({
    ...card,
    avatar: card.avatar ?? null,
    textAvatar: card.textAvatar ?? null,
    activeNow: false,
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

export function SidebarAgentRoster(props: {
  host: RosterHost;
  active: boolean;
  sections: SidebarVisibleSections["sections"];
}) {
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
  let focusAfterPin: string | undefined;
  const createAgentLinkRef = (card: () => { id: string }) => {
    let link: HTMLAnchorElement | undefined;
    onSettled(() => {
      // The keyed row keeps this identity until its branch is removed.
      const id = card().id;
      if (link) {
        agentLinks.set(id, link);
        if (focusAfterPin === id) {
          focusAfterPin = undefined;
          link.focus();
        }
      }
      return () => {
        if (agentLinks.get(id) === link) {
          agentLinks.delete(id);
        }
      };
    });
    return (element: HTMLAnchorElement) => {
      link = element;
    };
  };
  const parkedSections = createParkedProjection(() => props.sections, presented);
  const sectionsByAgent = createMemo(() => {
    const indexed = new Map<string, SidebarVisibleSections["sections"]>();
    for (const section of parkedSections()) {
      const agentId = /^agent:([^:]+):/.exec(section.id)?.[1];
      if (agentId) {
        const sections = indexed.get(agentId);
        if (sections) {
          sections.push(section);
        } else {
          indexed.set(agentId, [section]);
        }
      }
    }
    return indexed;
  });
  const navigation = createMemo(() => projectOwner(context.navigation, (owner) => owner.snapshot));
  const pinnedIds = createParkedProjection(
    () => new Set(navigation().read().pinnedAgentIds),
    presented,
  );
  const pinnedCards = createMemo(() => cards().filter((card) => pinnedIds().has(card.id)));
  const unpinnedCards = createMemo(() => cards().filter((card) => !pinnedIds().has(card.id)));
  const rosterWindow = createSidebarRosterWindow(
    unpinnedCards,
    () =>
      cards().find(
        (card) =>
          isSessionRouteId(host().activeRouteId) &&
          areUiSessionKeysEquivalent(
            host().getRouteSessionKey(),
            host().selectedAgentMainSessionKey(card.id),
          ),
      )?.id,
  );
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
    }).catch((error: unknown) => {
      showToast({ message: formatUiError(error) });
      return false;
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
  // Pinned tiles and roster rows share one action list; only the opening affordance differs.
  const agentMenuItems = (card: AgentMenuCard): MenuEntry[] => {
    const pinned = pinnedIds().has(card.id);
    return [
      {
        id: "pin",
        label: t(pinned ? "nav.unpin" : "nav.pin"),
        class: ["sidebar-customize-menu__item", { "sidebar-agent-roster__pin--pinned": pinned }],
        icon: <Icon name="pin" />,
      },
      {
        id: "sessions",
        label: t("agentsHome.viewSessions"),
        class: "sidebar-customize-menu__item",
        icon: <Icon name="listTree" />,
      },
      ...(canCreateClawDraft(context)
        ? [
            {
              id: "create-claw",
              label: t("clawsDraft.title"),
              class: "sidebar-customize-menu__item",
              icon: <Icon name="share" />,
            },
          ]
        : []),
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
        variant: "danger" as const,
        disabled: !canDeleteAgent(card.id),
      },
    ];
  };
  const selectAgentMenuItem = (itemId: string, card: AgentMenuCard) => {
    switch (itemId) {
      case "pin":
        // The destination row registers after the pinned/unpinned branch changes.
        focusAfterPin = card.id;
        rosterWindow.focus(card.id);
        togglePinnedAgent(context.navigation, card.id);
        break;
      case "sessions":
        context.agentSelection.setScope(card.id);
        host().onNavigate?.("sessions");
        break;
      case "create-claw":
        clawCreatorAction(context, card.id)?.();
        break;
      case "settings":
        context.navigate("agents", {
          pathname: pathForAgentPanel(card.id, null, context.basePath),
        });
        break;
      case "delete":
        void deleteAgent(card);
        break;
    }
  };
  const [contextMenu, setContextMenu] = createSignal<AgentContextMenu | null>(null);
  const openContextMenu = (id: string, event: MouseEvent | KeyboardEvent) =>
    handleContextMenuEvent(event, agentLinks.get(id) ?? null, (anchor, x, y) => {
      host().dismissTransientMenus();
      setContextMenu({ id, x, y, anchor });
    });
  const agentMenu = (card: () => AgentMenuCard, point?: AgentContextMenu) => {
    const items = createMemo(() => agentMenuItems(card()));
    const contextId = point && `sidebar-agent-roster-context-${createUniqueId()}`;
    // Context menus open at the pointer or shortcut target; roster rows also keep a kebab.
    const opening = point
      ? { open: true, triggerAttributes: pointMenuTriggerAttributes(point) }
      : {
          lazy: true,
          triggerClass: "sidebar-agent-roster__action",
          trigger: <Icon name="moreHorizontal" />,
        };
    return (
      <Menu
        {...opening}
        id={contextId || `sidebar-agent-roster-${card().id}`}
        class="sidebar-customize-menu sidebar-agent-roster__menu"
        placement={point ? "bottom-start" : "bottom-end"}
        label={t("agentsHome.agentOptions", { agent: card().name })}
        ref={({ overlay }) => {
          overlay.surface.dataset.chatAutotypeExempt = "";
          if (point) {
            if (point.anchor) {
              overlay.setReturnTarget(point.anchor);
            }
            overlay.request(true, "first");
          }
        }}
        onBeforeShow={() => {
          if (!point) {
            host().dismissTransientMenus();
          }
        }}
        onOpenChange={(open) => {
          if (point && !open) {
            setContextMenu((current) => (current === point ? null : current));
          }
        }}
        onSelect={(item) => selectAgentMenuItem(item.id, card())}
        items={items()}
      />
    );
  };
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
                      onContextMenu={(event) => openContextMenu(card().id, event)}
                      onKeyDown={(event) => openContextMenu(card().id, event)}
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
                          onClick={(event: MouseEvent) =>
                            handleNavigationClick(event, () => host().openMainSession(card().id))
                          }
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
                    </div>
                  );
                }}
              </For>
            </section>
          </Show>
          <div
            ref={rosterWindow.bind}
            class="sidebar-agent-roster__window"
            style={{ position: "relative", height: rosterWindow.height() }}
          >
            <For each={rosterWindow.cards()} keyed={(card) => card.id}>
              {(card) => {
                const linkRef = createAgentLinkRef(card);
                const mainKey = () => host().selectedAgentMainSessionKey(card().id);
                const sections = createMemo(() => sectionsByAgent().get(card().id) ?? []);
                const parkedMain = createParkedProjection(
                  () => host().visibleHomeSession(card().id),
                  presented,
                );
                const main = createMemo(() => parkedMain());
                const summaryRows = createMemo(() => [
                  ...(main() ? [main()!] : []),
                  ...sections().flatMap((section) => section.rows),
                ]);
                const headerSummary = createMemo<TeamSessionSlotsProps>(() => {
                  const rows = summaryRows();
                  return {
                    rows,
                    includeChildren: true,
                    childCount: 0,
                    groupConflicts: rows.reduce(
                      (count, row) => count + (row.workspaceConflictCount ?? 0),
                      0,
                    ),
                    statusOnly: true,
                  };
                });
                const active = () =>
                  isSessionRouteId(host().activeRouteId) &&
                  areUiSessionKeysEquivalent(host().getRouteSessionKey(), mainKey());
                return (
                  <section
                    class={[
                      "sidebar-agent-roster__group",
                      {
                        "sidebar-agent-roster__group--windowed":
                          rosterWindow.position(card().id) !== undefined,
                      },
                    ]}
                    style={{
                      position:
                        rosterWindow.position(card().id) !== undefined ? "absolute" : undefined,
                      "inset-inline":
                        rosterWindow.position(card().id) !== undefined ? "0" : undefined,
                      top: rosterWindow.position(card().id),
                    }}
                    onFocusIn={() => rosterWindow.focus(card().id)}
                    data-agent-group={card().id}
                    aria-label={card().name}
                  >
                    <div
                      class={[
                        "sidebar-agent-roster__header session-row-host",
                        { "sidebar-agent-roster__header--current": active() },
                      ]}
                      onContextMenu={(event) => openContextMenu(card().id, event)}
                      onKeyDown={(event) => openContextMenu(card().id, event)}
                    >
                      <a
                        ref={linkRef}
                        class="sidebar-agent-roster__row"
                        data-agent-id={card().id}
                        href={card().target.href}
                        aria-current={active() ? "page" : undefined}
                        onClick={(event: MouseEvent) =>
                          handleNavigationClick(event, () => host().openMainSession(card().id))
                        }
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
                  </section>
                );
              }}
            </For>
          </div>
          <Show when={presented() && contextMenu()} keyed>
            {(menu) => (
              <Show when={cards().find((card) => card.id === menu.id)}>
                {(card) => agentMenu(card, menu)}
              </Show>
            )}
          </Show>
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

export function SidebarPinnedSession(props: { host: RosterHost; session: SidebarRecentSession }) {
  const session = () => props.session;
  const agentId = createMemo(() => props.host.sessionNavigationAgentId(session()));
  const card = createMemo(() => {
    const cards =
      cachedRosterCards(props.host) ??
      (props.host.sessionDataContext
        ? rosterActivityStore(props.host.sessionDataContext).snapshot.cards
        : []);
    return cards.find((agent) => agent.id === agentId());
  });
  return (
    <SessionTree
      host={props.host}
      session={session()}
      listItem={false}
      icon={<AgentIdentityAvatar agent={card() ?? { id: agentId() }} />}
    />
  );
}

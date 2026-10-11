import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { projectRosterActivity } from "../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { newSessionSearch } from "../pages/new-session/location.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { renderPersonalSessionEmpty } from "./app-sidebar-session-filter-summary.tsx";
import {
  renderSessionListFrame,
  renderSessionSection,
} from "./app-sidebar-session-list-render.tsx";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import {
  renderChildSessionLoadError,
  renderSessionTree,
  renderSidebarSessionIndicators,
} from "./app-sidebar-session-row-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
import { renderTeamSessionSlots, sessionRunVisibility } from "./solid/session-presentation.tsx";
import "../styles/sidebar-agent-roster.css";

registerEnglishCatalog(registerAgentsHomeEnglish);
type RosterHost = AppSidebarRenderHost & SessionListHost;
type RosterProps = { host: RosterHost; active?: boolean };

function cachedRosterCards(host: RosterHost) {
  return host.sidebarSnapshot?.cards.map((card) => ({
    ...card,
    avatar: card.avatar ?? null,
    textAvatar: card.textAvatar ?? null,
    role: card.role,
    model: card.model,
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
  const currentHost = createMemo(() => props.host);
  const hostProjection = createMemo(() =>
    projectSource(currentHost(), {
      read: (host) => host,
      subscribe: (host, notify) => host.subscribe(notify),
      equality: "revision",
    }),
  );
  const host = () => hostProjection().read();
  const context = createMemo(() => host().sessionDataContext ?? application);
  const store = createMemo(() => rosterActivityStore(context()));
  const projection = createMemo(() => projectRosterActivity(store()));
  const gateway = createMemo(() => projectGateway(context().gateway));
  const snapshot = createMemo(() =>
    props.active === false ? store().snapshot : projection().read(),
  );
  const [avatarRevision, setAvatarRevision] = createSignal(0, { ownedWrite: true });
  const avatars = new IdentityAvatarController(() => setAvatarRevision((value) => value + 1));
  onSettled(() => {
    avatars.hostConnected();
    return () => avatars.hostDisconnected();
  });
  const cards = createMemo(() => {
    const cached = cachedRosterCards(host());
    if (cached) {
      return avatars.withActiveRoutes(() => cached);
    }
    avatarRevision();
    const currentCards = snapshot().cards;
    const currentContext = context();
    return avatars.withActiveRoutes(() =>
      currentCards.map((card) =>
        Object.assign({}, card, {
          avatar: card.avatar ? avatars.resolve(card.avatar) : null,
          target: sessionNavigationTarget({
            context: currentContext,
            face: "chat",
            sessionKey: card.mainKey,
            agentId: card.id,
          }),
        }),
      ),
    );
  });
  return { host, context, store, snapshot, gateway, cards };
}

function SidebarAgentRosterContent(
  props: RosterProps & {
    sections?: SidebarVisibleSections["sections"];
    involvingMe?: boolean;
    empty?: boolean;
  },
) {
  const roster = useRoster(props);
  const settingsScope = () => roster.gateway().read().connection.gatewayUrl;
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(
    new Set(
      untrack(() => props.host.sidebarSnapshot?.collapsedAgentIds) ??
        loadSettings(settingsScope()).sidebarCollapsedAgentIds ??
        [],
    ),
  );
  createEffect(settingsScope, (gatewayUrl) => {
    setCollapsed(
      new Set(
        props.host.sidebarSnapshot?.collapsedAgentIds ??
          loadSettings(gatewayUrl).sidebarCollapsedAgentIds ??
          [],
      ),
    );
  });
  createEffect(
    () => [roster.store(), props.involvingMe ?? false] as const,
    ([store, involvingMe]) => {
      store.setInvolvingMe(involvingMe);
    },
  );
  createEffect(roster.store, (store) => () => store.setInvolvingMe(false));
  createEffect(
    () => ({ snapshot: roster.snapshot(), collapsed: collapsed() }),
    ({ snapshot, collapsed: collapsedIds }) => {
      const host = props.host;
      host.rosterSessionSource = {
        result: snapshot.result,
        agentIds: snapshot.cards.map((card) => card.id),
        collapsedAgentIds: collapsedIds,
      };
      host.requestUpdate();
    },
  );
  createEffect(
    () => props.host,
    (host) => () => {
      host.rosterSessionSource = null;
      host.requestUpdate();
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
    <>
      {renderSessionListFrame(
        roster.host(),
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
              const runVisibility = sessionRunVisibility();
              const sections = () =>
                (props.sections ?? []).filter((section) =>
                  section.id.startsWith(`agent:${card().id}:`),
                );
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
              const main = () => roster.host().visibleHomeSession(card().id);
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
              const headerSummary = (): Parameters<typeof renderTeamSessionSlots> => [
                summaryRows(),
                isCollapsed(),
                isCollapsed()
                  ? sections().reduce((count, section) => count + section.rows.length, 0)
                  : 0,
                summaryRows().reduce((count, row) => count + (row.workspaceConflictCount ?? 0), 0),
                runVisibility,
              ];
              const access = () => roster.host().readNewSessionAccess();
              return (
                <section
                  class="sidebar-agent-roster__group"
                  data-agent-group={card().id}
                  aria-label={card().name}
                >
                  <div class="sidebar-agent-roster__header session-row-host">
                    <Show when={hasSessions()}>
                      <button
                        type="button"
                        class="sidebar-agent-roster__action sidebar-agent-roster__chevron"
                        data-agent-collapse={card().id}
                        aria-label={t(
                          isCollapsed() ? "agentsHome.expandAgent" : "agentsHome.collapseAgent",
                          { agent: card().name },
                        )}
                        aria-expanded={isCollapsed() ? "false" : "true"}
                        onClick={() => toggleAgent(card().id)}
                      >
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
                      <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                        <AgentIdentityAvatar agent={card()} />
                      </span>
                      <span class="sidebar-agent-roster__copy">
                        <span>{card().name}</span>
                      </span>
                    </a>
                    <span class="sidebar-agent-roster__signals">
                      {main()
                        ? renderSidebarSessionIndicators(
                            roster.host(),
                            () => main()!,
                            undefined,
                            undefined,
                            headerSummary(),
                          ).content
                        : renderTeamSessionSlots(...headerSummary())}
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
                        className: "sidebar-agent-roster__action sidebar-agent-roster__new",
                        get label() {
                          return `${t("agentChip.newConversation")}: ${card().name}`;
                        },
                        get disabledReason() {
                          const currentAccess = access();
                          return currentAccess.allowed ? undefined : currentAccess.reason;
                        },
                        onOpen: (id, target) => roster.host().requestOpenNewSession(id, target),
                      })}
                      <wa-dropdown
                        class="sidebar-customize-menu sidebar-agent-roster__menu"
                        placement="bottom-end"
                        onWa-show={() => roster.host().dismissTransientMenus()}
                        onWa-select={(event: WaSelectEvent) => {
                          switch (event.detail.item.getAttribute("value")) {
                            case null:
                              break;
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
                      >
                        <button
                          slot="trigger"
                          type="button"
                          class="sidebar-agent-roster__action"
                          aria-label={t("agentsHome.agentOptions", { agent: card().name })}
                        >
                          <Icon name="moreHorizontal" />
                        </button>
                        <wa-dropdown-item class="sidebar-customize-menu__item" value="main">
                          <span slot="icon" class="nav-item__icon">
                            <Icon name="messageSquare" />
                          </span>
                          {t("agentsHome.openMainChat")}
                        </wa-dropdown-item>
                        <wa-dropdown-item class="sidebar-customize-menu__item" value="sessions">
                          <span slot="icon" class="nav-item__icon">
                            <Icon name="listTree" />
                          </span>
                          {t("agentsHome.allSessions")}
                        </wa-dropdown-item>
                        <wa-dropdown-item
                          class="sidebar-customize-menu__item"
                          value="collapse-others"
                        >
                          <span slot="icon" class="nav-item__icon">
                            <Icon name="foldVertical" />
                          </span>
                          {t("agentsHome.collapseOthers")}
                        </wa-dropdown-item>
                      </wa-dropdown>
                    </span>
                  </div>
                  <Show when={!isCollapsed()}>
                    <For each={homeLoadKeys()}>
                      {(key) => renderChildSessionLoadError(roster.host(), key)}
                    </For>
                    <For each={sections()} keyed={(section) => section.id}>
                      {(section) =>
                        renderSessionSection({
                          get host() {
                            return roster.host();
                          },
                          get section() {
                            return section();
                          },
                          personHeaders: undefined,
                        })
                      }
                    </For>
                  </Show>
                </section>
              );
            }}
          </For>
          {renderPersonalSessionEmpty(
            roster.host(),
            props.empty ?? false,
            roster.gateway().read().snapshot.phase === "connected" &&
              roster.snapshot().result !== null &&
              !roster.snapshot().loading &&
              !error() &&
              !roster.snapshot().result!.hasMore &&
              !roster.host().sessionData.sessionMutationError,
          )}
        </div>,
      )}
    </>
  );
}

function SidebarNewSessionMenuContent(
  props: RosterProps & { access: ReturnType<RosterHost["readNewSessionAccess"]> },
) {
  const roster = useRoster(props);
  const access = () => props.access;
  let dropdown!: HTMLElement & { open: boolean };
  return (
    <>
      <wa-dropdown
        ref={(element) => {
          dropdown = element;
        }}
        class="sidebar-new-session-menu"
        placement="bottom-end"
        aria-label={t("agentChip.agents")}
        onWa-show={() => roster.host().dismissTransientMenus()}
        onWa-select={(event: WaSelectEvent) => {
          const item = event.detail.item;
          event.preventDefault();
          if (item.hasAttribute("data-native-navigation")) {
            item.removeAttribute("data-native-navigation");
            return;
          }
          const id = item.getAttribute("value");
          if (access().allowed && id && roster.cards().some((card) => card.id === id)) {
            dropdown.open = false;
            roster.host().requestOpenNewSession(id);
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class="sidebar-session-toolbar__button sidebar-new-session"
          aria-label={t("agentChip.newConversation")}
          title={props.access.allowed ? t("agentChip.newConversation") : props.access.reason}
          disabled={!access().allowed || roster.cards().length === 0}
        >
          <Icon name="plus" />
        </button>
        <For each={roster.cards()} keyed={(card) => card.id}>
          {(card) => (
            <wa-dropdown-item
              value={card().id}
              ref={(item) => {
                // Run before Web Awesome synchronously emits its selection event.
                item.addEventListener("click", (event) => {
                  if (shouldHandleNavigationClick(event)) {
                    event.preventDefault();
                  } else {
                    item.setAttribute("data-native-navigation", "");
                  }
                });
              }}
            >
              <a
                class="sidebar-agent-roster__link"
                href={`${pathForRoute("new-session", roster.host().basePath)}${newSessionSearch(card().id)}`}
                tabindex={-1}
              >
                <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                  <AgentIdentityAvatar agent={card()} />
                </span>
                <span>{card().name}</span>
              </a>
            </wa-dropdown-item>
          )}
        </For>
      </wa-dropdown>
    </>
  );
}

type RosterBridgeProps = { host: RosterHost | null; active: boolean };
type AgentRosterBridgeProps = RosterBridgeProps & {
  sections: SidebarVisibleSections["sections"];
  involvingMe: boolean;
  empty: boolean;
};

export const SidebarAgentRoster = defineSolidBridge<AgentRosterBridgeProps>(
  "openclaw-sidebar-agent-roster",
  (props) => (
    <Show when={props.host}>
      {(host) => (
        <SidebarAgentRosterContent
          host={host()}
          active={props.active}
          sections={props.sections}
          involvingMe={props.involvingMe}
          empty={props.empty}
        />
      )}
    </Show>
  ),
  {
    properties: {
      host: { default: null, attribute: false },
      active: { default: true, type: Boolean },
      sections: { default: [], attribute: false },
      involvingMe: { default: false, attribute: false },
      empty: { default: false, type: Boolean },
    },
  },
);

export const SidebarNewSessionMenu = defineSolidBridge<
  RosterBridgeProps & { access: ReturnType<RosterHost["readNewSessionAccess"]> | null }
>(
  "openclaw-sidebar-new-session-menu",
  (props) => (
    <Show when={props.host}>
      {(host) => (
        <Show when={props.access}>
          {(access) => (
            <SidebarNewSessionMenuContent host={host()} active={props.active} access={access()} />
          )}
        </Show>
      )}
    </Show>
  ),
  {
    properties: {
      host: { default: null, attribute: false },
      active: { default: true, type: Boolean },
      access: { default: null, attribute: false },
    },
  },
);

export function renderSidebarPinnedSession(host: RosterHost, session: () => SidebarRecentSession) {
  const agentId = createMemo(() => host.sessionNavigationAgentId(session()));
  const card = createMemo(() => {
    const cards =
      cachedRosterCards(host) ??
      (host.sessionDataContext ? rosterActivityStore(host.sessionDataContext).snapshot.cards : []);
    return cards.find((agent) => agent.id === agentId());
  });
  return renderSessionTree({
    host,
    get session() {
      return session();
    },
    listItem: false,
    get icon() {
      return <AgentIdentityAvatar agent={card() ?? { id: agentId() }} />;
    },
  });
}

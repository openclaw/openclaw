import {
  createEffect,
  createMemo,
  createSignal,
  flush,
  For,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { isSessionRouteId } from "../app-route-paths.ts";
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
  const host = () => hostProjection().read();
  const context = createMemo(() => host().sessionDataContext ?? application);
  const store = createMemo(() => rosterActivityStore(context()));
  const projection = createMemo(() => projectRosterActivity(store()));
  const gateway = createMemo(() => projectGateway(context().gateway));
  const snapshot = createMemo(() => (props.active ? projection().read() : store().snapshot));
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

export function SidebarAgentRoster(props: RosterProps) {
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
    () => [roster.store(), props.involvingMe] as const,
    ([store, involvingMe]) => {
      store.setInvolvingMe(involvingMe);
    },
  );
  createEffect(roster.store, (store) => () => store.setInvolvingMe(false));
  // Roster publications invalidate the parent, which reads the live store directly.
  createEffect(
    () => ({ snapshot: roster.snapshot(), collapsed: collapsed() }),
    ({ collapsed: collapsedIds }) => {
      const host = props.host;
      host.rosterCollapsedAgentIds = collapsedIds;
      host.sessionData.requestSessionDataUpdate();
    },
  );
  createEffect(
    () => props.host,
    (host) => () => {
      host.rosterCollapsedAgentIds = null;
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
              const [menuOpened, setMenuOpened] = createSignal(false);
              let removeMenuPreparation: (() => void) | undefined;
              onCleanup(() => removeMenuPreparation?.());
              const runVisibility = sessionRunVisibility;
              const sections = () =>
                props.sections.filter((section) => section.id.startsWith(`agent:${card().id}:`));
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
                      <Menu
                        id={`sidebar-agent-roster-${card().id}`}
                        class="sidebar-customize-menu sidebar-agent-roster__menu"
                        placement="bottom-end"
                        label={t("agentsHome.agentOptions", { agent: card().name })}
                        triggerClass="sidebar-agent-roster__action"
                        trigger={<Icon name="moreHorizontal" />}
                        ref={({ overlay }) => {
                          overlay.surface.dataset.chatAutotypeExempt = "";
                          const trigger = overlay.trigger!;
                          const prepare = () => {
                            setMenuOpened(true);
                            // Populate lazy rows before the menu's admission check.
                            flush();
                          };
                          const keydown = (event: KeyboardEvent) => {
                            if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
                              prepare();
                            }
                          };
                          trigger.addEventListener("click", prepare, true);
                          trigger.addEventListener("keydown", keydown, true);
                          removeMenuPreparation = () => {
                            trigger.removeEventListener("click", prepare, true);
                            trigger.removeEventListener("keydown", keydown, true);
                          };
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
                        items={
                          menuOpened()
                            ? [
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
                              ]
                            : []
                        }
                      />
                    </span>
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
          {renderPersonalSessionEmpty(
            roster.host(),
            props.empty,
            roster.gateway().read().snapshot.phase === "connected" &&
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

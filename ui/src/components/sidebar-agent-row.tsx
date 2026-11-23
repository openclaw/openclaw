import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, lazy, Loading, onSettled, Show } from "solid-js";
import { isSessionRouteId } from "../app-route-paths.ts";
import { hasSameOriginGatewayTransport } from "../dev-gateway.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { resolveTrustedAvatarUrl } from "../lib/identity-avatar.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { AgentRowContextMenu } from "./sidebar-agent-row-menu.tsx";
import { useAvatarGatewayContext } from "./solid/identity-avatar-view.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import {
  renderSessionUnreadBadge,
  SessionGlyph,
  SessionRowBadges,
  sessionRunVisibility,
} from "./solid/session-presentation.tsx";
import "../styles/sidebar-agent-roster.css";

// The menu brings agent creation, deletion and templates; it loads on first use.
const AgentRowMenu = lazy(() => import("./sidebar-agent-row-menu.tsx"), {
  export: "SidebarAgentRowMenu",
});

export type SidebarAgentRowCard = {
  id: string;
  name: string;
  avatar: string | null;
  textAvatar?: string | null;
  /** A Gateway avatar route waits for credentials instead of flashing a fallback. */
  pending?: boolean;
  href: string;
  assistantPreview?: string;
};

/** One agent's main conversation: the same row in the one-agent list and in the roster. */
export function SidebarAgentRow(props: {
  card: SidebarAgentRowCard;
  current: boolean;
  running: boolean;
  unread?: boolean;
  /** Keeps the menu visible with a dot: other agents have unread conversations. */
  attention?: boolean;
  /** Outbox and draft state of the main conversation, beside the name. */
  badges?: JSX.Element;
  /** Gateway environment label; marks the agent you are using on this Gateway. */
  environment?: string;
  linkRef?: (element: HTMLAnchorElement) => void;
  claimFocus?: (agentId: string) => boolean;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent | KeyboardEvent) => void;
  signals?: JSX.Element;
  actions?: JSX.Element;
}) {
  let link: HTMLAnchorElement | undefined;
  onSettled(() => {
    if (link && props.claimFocus?.(props.card.id)) {
      link.focus();
    }
  });
  return (
    <div
      class={[
        "sidebar-agent-roster__header session-row-host",
        {
          "sidebar-agent-roster__header--current": props.current,
          "sidebar-agent-roster__header--attention": props.attention,
        },
      ]}
      onContextMenu={(event) => props.onContextMenu(event)}
      onKeyDown={(event) => props.onContextMenu(event)}
    >
      <a
        ref={(element: HTMLAnchorElement) => {
          link = element;
          props.linkRef?.(element);
        }}
        class="sidebar-agent-roster__row"
        data-agent-id={props.card.id}
        href={props.card.href}
        aria-current={props.current ? "page" : undefined}
        onClick={(event: MouseEvent) => handleNavigationClick(event, () => props.onOpen())}
      >
        <span
          class={[
            "sidebar-agent-roster__avatar",
            // The run ring takes the avatar edge while the agent works.
            {
              "sidebar-agent-roster__avatar--environment":
                Boolean(props.environment) && !props.running,
            },
          ]}
          aria-hidden="true"
        >
          <SessionGlyph
            circular
            content={<AgentIdentityAvatar agent={props.card} />}
            running={props.running}
            runVisibility={sessionRunVisibility}
            badge={props.unread && !props.running ? renderSessionUnreadBadge() : undefined}
          />
        </span>
        <span class="sidebar-agent-roster__copy">
          <span class="sidebar-agent-roster__title">
            <span class="sidebar-agent-roster__name">{props.card.name}</span>
            <Show when={props.environment}>
              {(label) => <span class="control-ui-environment-pill">{label()}</span>}
            </Show>
            {props.badges}
          </span>
          <Show when={props.card.assistantPreview}>
            <span class="sidebar-agent-roster__preview">{props.card.assistantPreview}</span>
          </Show>
          <Show when={props.running}>
            <span class="sr-only">{t("sessionsView.activeRun")}</span>
          </Show>
        </span>
      </a>
      <span class="sidebar-agent-roster__signals">{props.signals}</span>
      <span class="sidebar-agent-roster__actions">
        {/* A menu anchors to its row; in a hidden drawer it waits without holding the page. */}
        <Loading>{props.actions}</Loading>
      </span>
    </div>
  );
}

/** The selected agent leads its own list, so its main conversation is always one click away. */
export function SidebarSelectedAgentRow(props: { host: AppSidebarRenderHost }) {
  const host = () => props.host;
  const avatarGateway = useAvatarGatewayContext();
  const chip = createMemo(() => host().activeChipAgent());
  const agentId = () => chip().activeId;
  const gateway = () => host().sessionDataContext?.gateway;
  // Same-origin bootstrap config names the agent before the roster loads.
  const bootstrap = createMemo(() => {
    const identity =
      gateway() && hasSameOriginGatewayTransport(gateway()?.connection.gatewayUrl ?? "")
        ? host().sessionDataContext?.config.current.assistantIdentity
        : undefined;
    return identity?.agentId === agentId() ? identity : undefined;
  });
  const agent = createMemo(
    () =>
      chip().agent ??
      (bootstrap()
        ? {
            id: agentId(),
            name: bootstrap()?.name,
            identity: { avatar: bootstrap()?.avatar ?? undefined },
          }
        : undefined),
  );
  const avatarAuthReady = () =>
    Boolean(
      gateway() &&
      (gateway()?.snapshot.hello ||
        gateway()?.connection.token.trim() ||
        gateway()?.connection.password.trim() ||
        bootstrap()),
    );
  const cached = () =>
    host().sidebarSnapshot?.mode === "chip" && host().sidebarSnapshot?.brand.agentId === agentId()
      ? host().sidebarSnapshot!.brand
      : null;
  const mainKey = () => host().selectedAgentMainSessionKey(agentId());
  const main = createMemo(() => host().mainSessionRow(agentId()));
  const home = createMemo(() => host().visibleHomeSession(agentId()));
  const card = createMemo((): SidebarAgentRowCard | null => {
    const live = agent();
    const saved = cached();
    if (!live && !saved) {
      return null;
    }
    const context = host().sessionDataContext;
    const url = live ? resolveAgentAvatarUrl(live, chip().identity) : saved!.avatar;
    return {
      id: agentId(),
      name: live ? normalizeAgentLabel(live, chip().identity) : saved!.name,
      // Keep the sidebar's canonical-route policy; the avatar owns image loading.
      avatar: url?.startsWith("/") ? resolveTrustedAvatarUrl(url, avatarGateway().origin) : url,
      pending: Boolean(url?.startsWith("/") && !avatarAuthReady()),
      textAvatar: live ? resolveAgentTextAvatar(live, chip().identity) : saved!.textAvatar,
      href: (context
        ? sessionNavigationTarget({
            context,
            face: "chat",
            sessionKey: mainKey(),
            agentId: agentId(),
          })
        : sessionNavigationTarget({
            face: "chat",
            sessionKey: mainKey(),
            fallbackAgentId: agentId(),
            basePath: host().basePath,
          })
      ).href,
      assistantPreview: main()?.lastAssistantMessage?.text,
    };
  });
  const running = () =>
    Boolean(
      home() &&
      ((home()!.isRunVisuallyActive ?? home()!.hasActiveRun) || home()!.runningChildCount > 0),
    );
  const current = () =>
    isSessionRouteId(host().activeRouteId) &&
    areUiSessionKeysEquivalent(host().getRouteSessionKey(), mainKey());
  const [contextMenu, setContextMenu] = createSignal<AgentRowContextMenu | null>(null);
  let link: HTMLAnchorElement | undefined;
  const openContextMenu = (event: MouseEvent | KeyboardEvent) =>
    handleContextMenuEvent(event, link ?? null, (anchor, x, y) => {
      host().dismissTransientMenus();
      setContextMenu({ x, y, anchor });
    });
  return (
    <Show when={card()}>
      {(selected) => (
        <div class="sidebar-agent-roster sidebar-agent-roster--selected">
          <section class="sidebar-agent-roster__group" aria-label={selected().name}>
            <SidebarAgentRow
              card={selected()}
              environment={host().sessionDataContext?.config.current.environment?.label}
              current={current()}
              running={running()}
              unread={home()?.unread}
              attention={host().otherAgentsHaveUnread()}
              badges={
                <SessionRowBadges
                  outboxAttentionCount={home()?.outboxAttentionCount ?? 0}
                  hasComposerDraft={home()?.hasComposerDraft}
                />
              }
              linkRef={(element) => (link = element)}
              claimFocus={(id) => host().sidebarMenus.claimAgentRowFocus(id)}
              onOpen={() => host().openMainSession(selected().id)}
              onContextMenu={openContextMenu}
              actions={
                <AgentRowMenu
                  host={host()}
                  card={selected()}
                  othersUnread={host().otherAgentsHaveUnread()}
                />
              }
            />
            <Show when={contextMenu()} keyed>
              {(point) => (
                <Loading>
                  <AgentRowMenu
                    host={host()}
                    card={selected()}
                    point={point}
                    othersUnread={host().otherAgentsHaveUnread()}
                    onClose={() => setContextMenu((open) => (open === point ? null : open))}
                  />
                </Loading>
              )}
            </Show>
          </section>
        </div>
      )}
    </Show>
  );
}

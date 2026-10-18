import { createMemo, createSignal, onCleanup } from "solid-js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";

/** Sidebar identity row: who you're talking to. The whole body opens the
    agent menu (switcher + utilities) — the conversation itself lives on the
    Home page row, so this row carries profile semantics only. */
export type SidebarAgentCardProps = {
  compact?: boolean;
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
  avatarAuthReady: boolean;
  avatarText: string | null;
  environment: ControlUiEnvironment | null;
  menuOpen: boolean;
  menuUnread: boolean;
  switcherAvailable: boolean;
  onToggleMenu?: (trigger: HTMLElement) => void;
  onMenuPointerMove?: (trigger: HTMLElement, event: PointerEvent) => void;
  onMenuPointerLeave?: () => void;
};

function SidebarAgentCardContent(props: SidebarAgentCardProps, host: HTMLElement) {
  host.style.display = "contents";
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const avatarLoader = new IdentityAvatarController(() => setRevision((value) => value + 1));
  avatarLoader.hostConnected();
  onCleanup(() => avatarLoader.hostDisconnected());
  const avatar = createMemo(() => {
    revision();
    const sourceUrl = props.avatarUrl;
    const pending = Boolean(sourceUrl?.startsWith("/") && !props.avatarAuthReady);
    return avatarLoader.withActiveRoutes(() => {
      return {
        sourceUrl,
        pending,
        url: sourceUrl && !pending ? avatarLoader.resolve(sourceUrl) : null,
      };
    });
  });
  const menuLabel = () =>
    props.switcherAvailable ? t("agentChip.switchAgent") : t("agentChip.menuLabel");
  return (
    <div
      class={[
        "sidebar-agent-card",
        { "sidebar-agent-card--open": props.menuOpen, "sidebar-agent-card--rail": props.compact },
      ]}
    >
      <button
        type="button"
        class="sidebar-agent-card__main"
        aria-haspopup="menu"
        aria-expanded={props.menuOpen ? "true" : "false"}
        aria-label={`${props.agentName} · ${menuLabel()}`}
        onPointerMove={(event) => {
          if (props.switcherAvailable) {
            props.onMenuPointerMove?.(event.currentTarget, event);
          }
        }}
        onPointerLeave={() => props.onMenuPointerLeave?.()}
        onPointerDown={(event: PointerEvent) => {
          // The portaled menu has a hidden trigger; keep its outside-click
          // handler from dismissing hover-open state before click can pin it.
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggleMenu?.(event.currentTarget);
        }}
      >
        <span
          class={[
            "sidebar-agent-card__avatar",
            { "sidebar-agent-card__avatar--environment": Boolean(props.environment) },
          ]}
        >
          <AgentIdentityAvatar
            agent={{
              id: props.agentId,
              avatar: avatar().url,
              textAvatar: props.avatarText,
              pending: avatar().pending,
            }}
            onImageError={
              avatar().sourceUrl ? avatarLoader.imageErrorHandler(avatar().sourceUrl!) : undefined
            }
          />
          {props.menuUnread && !props.menuOpen ? (
            <span
              class="session-unread-dot sidebar-agent-card__menu-unread"
              role="img"
              aria-label={t("sessionsView.unread")}
            />
          ) : null}
        </span>
        <span class="sidebar-agent-card__text">
          <span class="sidebar-agent-card__name">
            {renderHoverMarquee(props.agentName, "sidebar-agent-card__name-text", {
              loop: true,
              delay: 300,
              speed: 35,
            })}
            <span class="sidebar-agent-card__chevron" aria-hidden="true">
              <Icon name="chevronsUpDown" />
            </span>
          </span>
          {props.environment ? (
            <span class="sidebar-agent-card__subtitle-row">
              <span class="control-ui-environment-pill">{props.environment.label}</span>
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

export const SidebarAgentCard = defineSolidBridge<SidebarAgentCardProps>(
  "openclaw-sidebar-agent-card",
  SidebarAgentCardContent,
  {
    properties: {
      compact: { default: false },
      agentId: { default: "", attribute: false },
      agentName: { default: "", attribute: false },
      avatarUrl: { default: null, attribute: false },
      avatarAuthReady: { default: false, attribute: false },
      avatarText: { default: null, attribute: false },
      environment: { default: null, attribute: false },
      menuOpen: { default: false, attribute: false },
      menuUnread: { default: false, attribute: false },
      switcherAvailable: { default: false, attribute: false },
      onToggleMenu: { default: undefined, attribute: false },
      onMenuPointerMove: { default: undefined, attribute: false },
      onMenuPointerLeave: { default: undefined, attribute: false },
    },
  },
);

import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, onCleanup } from "solid-js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
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
  onContextMenu?: SolidJSX.EventHandler<HTMLElement, MouseEvent>;
};

export function SidebarAgentCard(props: SidebarAgentCardProps) {
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
    <openclaw-sidebar-agent-card
      style={{ display: "contents" }}
      onContextMenu={(event) => props.onContextMenu?.(event)}
    >
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
    </openclaw-sidebar-agent-card>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-agent-card": HTMLAttributes<HTMLElement>;
    }
  }
}

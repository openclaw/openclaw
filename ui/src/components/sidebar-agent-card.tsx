import { createMemo, createSignal, merge, onCleanup } from "solid-js";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { t } from "../i18n/index.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { Icon } from "./solid/icon.tsx";
import { renderAgentIdentityAvatar } from "./solid/identity-avatar.tsx";

/** Sidebar identity row: who you're talking to. The whole body opens the
    agent menu (switcher + utilities) — the conversation itself lives on the
    Home page row, so this row carries profile semantics only. */
export type SidebarAgentCardProps = {
  agentId?: string;
  agentName?: string;
  avatarUrl?: string | null;
  avatarAuthReady?: boolean;
  avatarText?: string | null;
  environment?: ControlUiEnvironment | null;
  menuOpen?: boolean;
  menuUnread?: boolean;
  switcherAvailable?: boolean;
  onToggleMenu?: (trigger: HTMLElement) => void;
  onMenuPointerMove?: (trigger: HTMLElement, event: PointerEvent) => void;
  onMenuPointerLeave?: () => void;
};

export function SidebarAgentCard(input: SidebarAgentCardProps) {
  const props = merge(
    {
      agentId: "",
      agentName: "",
      avatarUrl: null,
      avatarAuthReady: false,
      avatarText: null,
      environment: null,
      menuOpen: false,
      menuUnread: false,
      switcherAvailable: false,
    },
    input,
  );
  const [revision, setRevision] = createSignal(0);
  const avatarLoader = new IdentityAvatarController({
    addController() {},
    removeController() {},
    requestUpdate: () => setRevision((value) => value + 1),
    updateComplete: Promise.resolve(true),
  });
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
    <div class={["sidebar-agent-card", { "sidebar-agent-card--open": props.menuOpen }]}>
      <button
        type="button"
        class="sidebar-agent-card__main"
        aria-haspopup="menu"
        aria-expanded={String(props.menuOpen)}
        aria-label={`${props.agentName} · ${menuLabel()}`}
        onPointerMove={(event: PointerEvent) => {
          if (props.switcherAvailable && event.currentTarget instanceof HTMLElement) {
            props.onMenuPointerMove?.(event.currentTarget, event);
          }
        }}
        onPointerLeave={() => props.onMenuPointerLeave?.()}
        onPointerDown={(event: PointerEvent) => {
          // The portaled menu has a hidden trigger; keep its outside-click
          // handler from dismissing hover-open state before click can pin it.
          event.stopPropagation();
        }}
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          if (event.currentTarget instanceof HTMLElement) {
            props.onToggleMenu?.(event.currentTarget);
          }
        }}
      >
        <span
          class={[
            "sidebar-agent-card__avatar",
            { "sidebar-agent-card__avatar--environment": Boolean(props.environment) },
          ]}
        >
          {renderAgentIdentityAvatar(
            {
              id: props.agentId,
              avatar: avatar().url,
              textAvatar: props.avatarText,
              pending: avatar().pending,
            },
            "",
            avatar().sourceUrl ? avatarLoader.imageErrorHandler(avatar().sourceUrl!) : undefined,
          )}
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

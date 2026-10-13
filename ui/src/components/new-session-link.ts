import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { readSessionMethodAccess, type SessionMethodAccess } from "../lib/session-method-access.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { newSessionSearch, type NewSessionTarget } from "../pages/new-session/location.ts";
import { icons } from "./icons.ts";
import { renderAgentIdentityAvatar, type AgentIdentity } from "./identity-avatar-view.ts";
import { renderShortcutHint } from "./kbd.ts";
import "./tooltip.ts";
import "../styles/sidebar-agent-roster.css";

export function renderNewSessionLink(params: {
  basePath: string;
  agentId: string;
  target?: NewSessionTarget;
  className: string;
  label: string;
  disabledReason?: string;
  showShortcut?: boolean;
  onOpen?: (agentId: string, target?: NewSessionTarget) => void;
}) {
  const disabled = Boolean(params.disabledReason);
  const href = `${pathForRoute("new-session", params.basePath)}${newSessionSearch(params.agentId, params.target)}`;
  const hint = params.showShortcut
    ? `${params.label} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession)})`
    : params.label;
  return html`<openclaw-tooltip
    .content=${params.disabledReason ?? hint}
    .contentTemplate=${
      params.disabledReason == null && params.showShortcut
        ? renderShortcutHint(params.label, KEYBOARD_SHORTCUT_COMBOS.newSession)
        : undefined
    }
  >
    <a
      class=${params.className}
      role="link"
      href=${disabled ? nothing : href}
      aria-label=${params.label}
      aria-disabled=${disabled ? "true" : nothing}
      tabindex=${disabled ? "-1" : nothing}
      @contextmenu=${(event: MouseEvent) => {
        // Section menus must not replace the browser's Open Link in New Tab actions.
        event.stopPropagation();
      }}
      @click=${(event: MouseEvent) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          params.onOpen?.(params.agentId, params.target);
        }
      }}
    >
      ${icons.plus}
    </a>
  </openclaw-tooltip>`;
}

/** Header variants share the same link gestures and current Gateway admission as the rail. */
export function renderContextNewSessionAction(
  context: ApplicationContext,
  className: string,
  agentId = normalizeAgentId(
    context.agentSelection.state.selectedId ?? context.gateway.snapshot.assistantAgentId,
  ),
) {
  const readAccess = () =>
    readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.create",
      params: {},
      sessionScope: true,
    });
  const access = readAccess();
  const onOpen = (id: string) => {
    if (readAccess().allowed) {
      context.navigate("new-session", { search: newSessionSearch(id) });
    }
  };
  if (context.theme.settings.sidebarAgentsMode === "roster") {
    return renderNewSessionMenu({ basePath: context.basePath, access, className, onOpen });
  }
  return renderNewSessionLink({
    basePath: context.basePath,
    agentId,
    className,
    label: t("agentChip.newConversation"),
    showShortcut: true,
    disabledReason: access.allowed ? undefined : access.reason,
    onOpen,
  });
}

class SidebarNewSessionMenu extends AgentRosterElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) triggerClass = "sidebar-rail__button sidebar-new-session";
  @property({ attribute: false }) snapshotCards: readonly AgentIdentity[] | null = null;
  // Callbacks are read at activation; replacing them must not repaint an unchanged menu.
  onOpen!: (agentId: string) => void;
  onShow?: () => void;
  @property({
    attribute: false,
    hasChanged: (value: SessionMethodAccess, previous?: SessionMethodAccess) =>
      value.allowed !== previous?.allowed ||
      (!value.allowed && (!previous || previous.allowed || value.reason !== previous.reason)),
  })
  access!: SessionMethodAccess;
  @state() private opened = false;

  override render() {
    return this.avatars.withActiveRoutes(() => {
      const access = this.access;
      const cards = this.snapshotCards ?? this.cards();
      return html`<wa-dropdown
        class="sidebar-new-session-menu"
        placement="bottom-end"
        aria-label=${t("agentChip.agents")}
        @wa-show=${() => {
          this.onShow?.();
          this.opened = true;
        }}
        @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
          const item = event.detail.item;
          event.preventDefault();
          if (item.dataset.nativeNavigation) {
            delete item.dataset.nativeNavigation;
            return;
          }
          const id = item.value;
          if (access.allowed && id && cards.some((card) => card.id === id)) {
            const dropdown = this.querySelector("wa-dropdown");
            if (dropdown) {
              dropdown.open = false;
            }
            this.onOpen(id);
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class=${this.triggerClass}
          aria-label=${t("agentChip.newConversation")}
          title=${access.allowed ? t("agentChip.newConversation") : access.reason}
          ?disabled=${!access.allowed || cards.length === 0}
        >
          ${icons.plus}
        </button>
        ${
          this.opened
            ? cards.map(
                (card) => html`<wa-dropdown-item
                  value=${card.id}
                  @click=${(event: MouseEvent) => {
                    if (shouldHandleNavigationClick(event)) {
                      event.preventDefault();
                    } else if (event.currentTarget instanceof HTMLElement) {
                      event.currentTarget.dataset.nativeNavigation = "true";
                    }
                  }}
                  ><a
                    class="sidebar-agent-roster__link"
                    href=${`${pathForRoute("new-session", this.basePath)}${newSessionSearch(card.id)}`}
                    tabindex="-1"
                    ><span class="sidebar-agent-roster__avatar" aria-hidden="true">
                      ${renderAgentIdentityAvatar(card)} </span
                    ><span>${card.name}</span></a
                  >
                </wa-dropdown-item>`,
              )
            : nothing
        }
      </wa-dropdown>`;
    });
  }
}

customElements.define("openclaw-sidebar-new-session-menu", SidebarNewSessionMenu);

export function renderNewSessionMenu(params: {
  basePath: string;
  access: SessionMethodAccess;
  className?: string;
  active?: boolean;
  snapshotCards?: readonly AgentIdentity[];
  onOpen: (agentId: string) => void;
  onShow?: () => void;
}) {
  return html`<openclaw-sidebar-new-session-menu
    .basePath=${params.basePath}
    .access=${params.access}
    .triggerClass=${params.className ?? "sidebar-rail__button sidebar-new-session"}
    .active=${params.active ?? true}
    .snapshotCards=${params.snapshotCards ?? null}
    .onOpen=${params.onOpen}
    .onShow=${params.onShow}
  ></openclaw-sidebar-new-session-menu>`;
}

// Chat-owned composer display controls: the View menu plus model controls.
import { html } from "lit";
import type { UiSettings } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { renderChatModelControls, type ChatModelControlsProps } from "./chat-model-controls.ts";

type ChatControlsProps = {
  paneId: string;
  model: ChatModelControlsProps;
  onboarding: boolean;
  settings: UiSettings;
  viewMenuOpen: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onViewMenuOpenChange: (
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) => void;
};

type ChatViewMenuRow = {
  label: string;
  checked: boolean;
  onToggle: () => void;
};

function chatViewMenuRows(props: ChatControlsProps): ChatViewMenuRow[] {
  const { settings, onboarding } = props;
  // Onboarding pins the display: no thinking noise, tool calls visible.
  const showThinking = onboarding ? false : settings.chatShowThinking;
  const showToolCalls = onboarding ? true : settings.chatShowToolCalls;
  const persistCommentary = settings.chatPersistCommentary === true;
  return [
    {
      label: t("chat.view.reasoning"),
      checked: showThinking,
      onToggle: () =>
        props.onSettingsChange({ ...settings, chatShowThinking: !settings.chatShowThinking }),
    },
    {
      label: t("chat.view.toolCalls"),
      checked: showToolCalls,
      onToggle: () =>
        props.onSettingsChange({ ...settings, chatShowToolCalls: !settings.chatShowToolCalls }),
    },
    {
      label: t("chat.view.commentary"),
      checked: persistCommentary,
      onToggle: () =>
        props.onSettingsChange({ ...settings, chatPersistCommentary: !persistCommentary }),
    },
  ];
}

export function renderChatControls(props: ChatControlsProps) {
  const open = props.viewMenuOpen;
  const menuTitle = props.onboarding ? t("chat.onboardingDisabled") : t("chat.view.menu");
  const menuId = `chat-view-menu-${encodeURIComponent(props.paneId)}`;
  return html`
    <div class="chat-view-menu-wrapper">
      <openclaw-tooltip .content=${menuTitle}>
        <wa-dropdown
          id=${menuId}
          class="chat-view-menu"
          placement="top-start"
          .open=${open}
          @wa-show=${() => {
            if (!open) {
              props.onViewMenuOpenChange(true);
            }
          }}
          @wa-hide=${() => {
            if (open) {
              props.onViewMenuOpenChange(false, { restoreFocus: true });
            }
          }}
        >
          <button
            slot="trigger"
            class="chat-view-menu-trigger ${open ? "chat-view-menu-trigger--open" : ""}"
            type="button"
            aria-label=${menuTitle}
            @click=${(event: Event) => event.stopPropagation()}
          >
            ${icons.eye}
          </button>
          ${chatViewMenuRows(props).map(
            (row, index) => html`
              <wa-dropdown-item
                class="chat-view-menu__item"
                type="checkbox"
                value=${`view-${index}`}
                .checked=${row.checked}
                ?disabled=${props.onboarding}
                @click=${() => {
                  if (!props.onboarding) {
                    row.onToggle();
                  }
                }}
              >
                <span class="chat-view-menu__text">${row.label}</span>
              </wa-dropdown-item>
            `,
          )}
        </wa-dropdown>
      </openclaw-tooltip>
    </div>
    <div
      class="chat-composer-model-control"
      @click=${() => {
        if (open) {
          props.onViewMenuOpenChange(false);
        }
      }}
    >
      ${renderChatModelControls(props.model)}
    </div>
  `;
}

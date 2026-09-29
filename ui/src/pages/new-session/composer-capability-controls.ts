import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import {
  renderChatComposerPlusMenu,
  type ChatComposerPlusMenuView,
} from "../chat/components/chat-composer-plus-menu.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

type NewSessionComposerCapabilityOptions = {
  submitting: boolean;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  sandboxAvailable?: boolean;
  sandboxCanChange?: boolean;
  sandboxRequired?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  textareaController: {
    capabilityMenuOpen: boolean;
    capabilityMenuView: ChatComposerPlusMenuView;
  };
  requestUpdate: () => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSandboxRequiredChange?: (required: boolean) => void;
};

export function renderNewSessionDraftVisibility(options: NewSessionComposerCapabilityOptions) {
  const active = options.visibility === "draft";
  const disabled = options.submitting || options.messageLocked;
  const label = t("newSession.draft");
  return html`
    <button
      type="button"
      class="new-session-page__composer-option new-session-page__visibility new-session-page__visibility--draft ${
        active ? "new-session-page__visibility--active" : ""
      }"
      role="switch"
      aria-label=${label}
      aria-checked=${String(active)}
      ?disabled=${disabled}
      title=${t("newSession.draftDescription")}
      @click=${() => options.onVisibilityChange?.(active ? "normal" : "draft")}
    >
      <span class="new-session-page__visibility-icon" aria-hidden="true">${icons.pencil}</span>
      <span class="new-session-page__composer-option-label new-session-page__visibility-label"
        >${label}</span
      >
    </button>
  `;
}

export function renderNewSessionSandboxRequirement(options: NewSessionComposerCapabilityOptions) {
  if (!options.sandboxAvailable) {
    return nothing;
  }
  const active = options.sandboxRequired === true;
  const disabled =
    options.submitting || options.messageLocked === true || options.sandboxCanChange !== true;
  const label = t("newSession.requireSandbox");
  const title = options.sandboxCanChange
    ? t("newSession.requireSandboxDescription")
    : t("newSession.requireSandboxRole");
  return html`
    <button
      type="button"
      class="new-session-page__composer-option new-session-page__sandbox ${
        active ? "new-session-page__sandbox--active" : ""
      }"
      role="switch"
      aria-label=${label}
      aria-checked=${String(active)}
      ?disabled=${disabled}
      title=${title}
      @click=${() => options.onSandboxRequiredChange?.(!active)}
    >
      <span class="new-session-page__sandbox-icon" aria-hidden="true">${icons.shieldLock}</span>
      <span class="new-session-page__composer-option-label">${label}</span>
    </button>
  `;
}

export function renderNewSessionPlusMenu(
  options: NewSessionComposerCapabilityOptions,
  attachments: Parameters<typeof renderChatComposerPlusMenu>[0]["attachments"],
) {
  const draftEnabled = options.visibility === "draft";
  const disabled = options.submitting || options.messageLocked === true;
  const controller = options.textareaController;
  const rootToggles = [
    ...(options.draftAvailable
      ? [
          {
            value: "new-session-draft",
            label: t("newSession.draft"),
            icon: icons.pencil,
            checked: draftEnabled,
            disabled,
            title: t("newSession.draftDescription"),
            onChange: (checked: boolean) =>
              options.onVisibilityChange?.(checked ? "draft" : "normal"),
          },
        ]
      : []),
    ...(options.sandboxAvailable
      ? [
          {
            value: "new-session-require-sandbox",
            label: t("newSession.requireSandbox"),
            icon: icons.shieldLock,
            checked: options.sandboxRequired === true,
            disabled: disabled || options.sandboxCanChange !== true,
            title:
              options.sandboxCanChange === true
                ? t("newSession.requireSandboxDescription")
                : t("newSession.requireSandboxRole"),
            onChange: (checked: boolean) => options.onSandboxRequiredChange?.(checked),
          },
        ]
      : []),
  ];
  return renderChatComposerPlusMenu({
    attachments,
    capabilityMenu: options.capabilityMenu,
    disabled,
    open: controller.capabilityMenuOpen,
    view: controller.capabilityMenuView,
    toolOverrides: options.toolOverrides,
    rootToggles: rootToggles.length ? rootToggles : undefined,
    onOpenChange: (open) => {
      controller.capabilityMenuOpen = open;
      if (!open) {
        controller.capabilityMenuView = "root";
      }
      options.requestUpdate();
    },
    onViewChange: (view) => {
      controller.capabilityMenuView = view;
      options.requestUpdate();
    },
  });
}

export function renderNewSessionSelectionStatus(options: NewSessionComposerCapabilityOptions) {
  const overrideCount = countSessionToolOverrides(options.toolOverrides);
  if (overrideCount === 0) {
    return nothing;
  }
  const disabled = options.submitting || options.messageLocked === true;
  const openMenu = () => {
    options.textareaController.capabilityMenuView = "root";
    options.textareaController.capabilityMenuOpen = true;
    options.requestUpdate();
  };
  return html`
    <button
      type="button"
      class="new-session-page__selection-status"
      ?disabled=${disabled}
      @click=${openMenu}
    >
      ${t(
        overrideCount === 1 ? "chat.composer.overrides.countOne" : "chat.composer.overrides.count",
        { count: String(overrideCount) },
      )}
    </button>
  `;
}

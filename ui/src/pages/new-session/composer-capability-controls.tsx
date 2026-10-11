import { createMemo, Show } from "solid-js";
import { icons } from "../../components/icons.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import {
  renderChatComposerPlusMenu,
  type ChatComposerCapabilityMenuProps,
  type ChatComposerPlusMenuView,
} from "../chat/components/chat-composer-plus-menu.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

type NewSessionComposerCapabilityOptions = {
  submitting: boolean;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  textareaController: {
    capabilityMenuOpen: boolean;
    capabilityMenuView: ChatComposerPlusMenuView;
  };
  requestUpdate: () => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
};

export function NewSessionDraftVisibility(props: { options: NewSessionComposerCapabilityOptions }) {
  const active = () => props.options.visibility === "draft";
  return (
    <button
      type="button"
      class={[
        "new-session-page__visibility new-session-page__visibility--draft",
        { "new-session-page__visibility--active": active() },
      ]}
      role="switch"
      aria-label={t("newSession.draft")}
      aria-checked={active() ? "true" : "false"}
      disabled={props.options.submitting || props.options.messageLocked}
      title={t("newSession.draftDescription")}
      onClick={() => props.options.onVisibilityChange?.(active() ? "normal" : "draft")}
    >
      <span class="new-session-page__visibility-icon" aria-hidden="true">
        <Icon name="pencil" />
      </span>
      <span class="new-session-page__visibility-label">{t("newSession.draft")}</span>
    </button>
  );
}

export function NewSessionPlusMenu(props: {
  options: NewSessionComposerCapabilityOptions;
  attachments: Parameters<typeof renderChatComposerPlusMenu>[0]["attachments"];
}) {
  const menu = createMemo(() => {
    const options = props.options;
    const disabled = options.submitting || options.messageLocked === true;
    const controller = options.textareaController;
    return renderChatComposerPlusMenu({
      attachments: props.attachments,
      capabilityMenu: options.capabilityMenu,
      disabled,
      open: controller.capabilityMenuOpen,
      view: controller.capabilityMenuView,
      toolOverrides: options.toolOverrides,
      rootToggles: options.draftAvailable
        ? [
            {
              value: "new-session-draft",
              label: t("newSession.draft"),
              icon: icons.pencil,
              checked: options.visibility === "draft",
              disabled,
              title: t("newSession.draftDescription"),
              onChange: (checked) => options.onVisibilityChange?.(checked ? "draft" : "normal"),
            },
          ]
        : undefined,
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
  });
  return <LitContent value={menu()} />;
}

export function NewSessionSelectionStatus(props: { options: NewSessionComposerCapabilityOptions }) {
  const count = () => countSessionToolOverrides(props.options.toolOverrides);
  return (
    <Show when={count() > 0}>
      <button
        type="button"
        class="new-session-page__selection-status"
        disabled={props.options.submitting || props.options.messageLocked === true}
        onClick={() => {
          props.options.textareaController.capabilityMenuView = "root";
          props.options.textareaController.capabilityMenuOpen = true;
          props.options.requestUpdate();
        }}
      >
        {t(count() === 1 ? "chat.composer.overrides.countOne" : "chat.composer.overrides.count", {
          count: String(count()),
        })}
      </button>
    </Show>
  );
}

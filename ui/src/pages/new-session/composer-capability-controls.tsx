import { createMemo, Show, useContext } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import { ChatComposerPlusMenu } from "../chat/components/chat-composer-plus-menu.tsx";
import type {
  ChatComposerPlusMenuProps,
  ChatComposerCapabilityMenuProps,
} from "../chat/components/chat-composer-plus-menu.types.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

type NewSessionComposerCapabilityOptions = {
  submitting: boolean;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  onChange: () => void;
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
  attachments: ChatComposerPlusMenuProps["attachments"];
  inputHandle: ChatComposerPlusMenuProps["inputHandle"];
}) {
  const textarea = useContext(NewSessionComposerTextareaContext);
  const menu = createMemo((): ChatComposerPlusMenuProps => {
    const options = props.options;
    const disabled = options.submitting || options.messageLocked === true;
    return {
      attachments: props.attachments,
      inputHandle: props.inputHandle,
      capabilityMenu: options.capabilityMenu,
      disabled,
      open: textarea.capabilityMenuOpen,
      view: textarea.capabilityMenuView,
      toolOverrides: options.toolOverrides,
      rootToggles: options.draftAvailable
        ? [
            {
              value: "new-session-draft",
              label: t("newSession.draft"),
              icon: "pencil",
              checked: options.visibility === "draft",
              disabled,
              title: t("newSession.draftDescription"),
              onChange: (checked) => options.onVisibilityChange?.(checked ? "draft" : "normal"),
            },
          ]
        : undefined,
      onOpenChange: (open) => {
        textarea.capabilityMenuOpen = open;
        if (!open) {
          textarea.capabilityMenuView = "root";
        }
        options.onChange();
      },
      onViewChange: (view) => {
        textarea.capabilityMenuView = view;
        options.onChange();
      },
    };
  });
  return <ChatComposerPlusMenu menu={menu()} />;
}

export function NewSessionSelectionStatus(props: { options: NewSessionComposerCapabilityOptions }) {
  const textarea = useContext(NewSessionComposerTextareaContext);
  const count = createMemo(() => countSessionToolOverrides(props.options.toolOverrides));
  return (
    <Show when={count() > 0}>
      <button
        type="button"
        class="new-session-page__selection-status"
        disabled={props.options.submitting || props.options.messageLocked === true}
        onClick={() => {
          textarea.capabilityMenuView = "root";
          textarea.capabilityMenuOpen = true;
          props.options.onChange();
        }}
      >
        {t(count() === 1 ? "chat.composer.overrides.countOne" : "chat.composer.overrides.count", {
          count: String(count()),
        })}
      </button>
    </Show>
  );
}

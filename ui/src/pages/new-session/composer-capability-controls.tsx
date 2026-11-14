import { createMemo, Show, useContext } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { ShortcutHint } from "../../components/solid/kbd.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isMobileBrowserPlatform } from "../../lib/browser-platform.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../lib/keyboard-shortcut-contract.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import { ChatComposerPlusMenu } from "../chat/components/chat-composer-plus-menu.tsx";
import type {
  ChatComposerPlusMenuProps,
  ChatComposerCapabilityMenuSource,
} from "../chat/components/chat-composer-plus-menu.types.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";

registerNewSessionSetupEnglish();

type NewSessionComposerCapabilityOptions = {
  submitting: boolean;
  messageLocked?: boolean;
  capabilityMenu?: ChatComposerCapabilityMenuSource;
  toolOverrides?: SessionToolOverrides | null;
  onChange: () => void;
};

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

export function StartControl(props: {
  options: {
    submitting: boolean;
    nativeTerminal?: boolean;
    requiresModifier: boolean;
    onBackgroundSubmit?: () => void;
    canSubmit: boolean;
    submitDisabledReason?: string;
    onBlockedSubmit?: () => void;
    attachmentDraft: { reads: { pendingReads: number } };
  };
  onSubmit: () => void;
}) {
  const label = () =>
    props.options.submitting
      ? t("newSession.starting")
      : t(props.options.nativeTerminal ? "newSession.startInTerminal" : "newSession.start");
  const busy = () =>
    props.options.submitting || props.options.attachmentDraft.reads.pendingReads > 0;
  const showShortcuts = () =>
    !isMobileBrowserPlatform() &&
    !props.options.nativeTerminal &&
    !busy() &&
    props.options.submitDisabledReason == null;
  return (
    <openclaw-tooltip
      prop:content={showShortcuts() ? "" : (props.options.submitDisabledReason ?? label())}
      onPointerDown={(event) => {
        if (event.button === 0 && !props.options.canSubmit) {
          props.options.onBlockedSubmit?.();
        }
      }}
    >
      <Show when={showShortcuts()}>
        <span slot="content" class="new-session-page__start-shortcuts">
          <ShortcutHint
            label={t("chat.runControls.send")}
            combo={
              props.options.requiresModifier
                ? KEYBOARD_SHORTCUT_COMBOS.modifiedEnter
                : KEYBOARD_SHORTCUT_COMBOS.sendMessage
            }
          />
          <Show when={props.options.onBackgroundSubmit}>
            <span class="muted" aria-hidden="true">
              ·
            </span>
            <ShortcutHint
              label={t("newSession.backgroundSend")}
              combo={
                props.options.requiresModifier
                  ? { modifiers: ["mod", "shift"], key: "Enter" }
                  : KEYBOARD_SHORTCUT_COMBOS.modifiedEnter
              }
            />
          </Show>
        </span>
      </Show>
      <button
        type="button"
        class={[
          "chat-send-btn new-session-page__start-submit",
          {
            "new-session-page__start-submit--busy": busy(),
          },
        ]}
        disabled={!props.options.canSubmit}
        aria-disabled={props.options.canSubmit ? "false" : "true"}
        aria-busy={busy() ? "true" : "false"}
        aria-label={label()}
        onClick={() => props.onSubmit()}
      >
        <Icon
          name={busy() ? "loader" : props.options.nativeTerminal ? "squareTerminal" : "arrowUp"}
        />
      </button>
    </openclaw-tooltip>
  );
}

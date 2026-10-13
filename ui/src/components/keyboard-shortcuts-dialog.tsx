import { For, Show } from "solid-js";
import { openShellNewSession, type ShellNewSessionHost } from "../app/app-shell-new-session.ts";
import type { ChatSendShortcut } from "../app/settings.ts";
import { resolveKeyboardShortcutSections } from "../lib/keyboard-shortcut-catalog.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import { KeyboardShortcut } from "./solid/kbd.tsx";
import "./keyboard-shortcuts-dialog.css";
import "./modal-dialog.ts";

type DialogProps = {
  sendShortcut: ChatSendShortcut;
  newSessionHost?: ShellNewSessionHost;
  isOpen: boolean;
};
type DialogMethods = { toggle(): void };
type KeyboardShortcutsDialogElement = SolidBridgeElement<DialogProps, DialogMethods>;

function KeyboardShortcutsContent(props: DialogProps & { host: KeyboardShortcutsDialogElement }) {
  const close = (event: Event) => {
    // Removal owns focus restoration; do not also queue the modal's close callback.
    event.preventDefault();
    props.host.isOpen = false;
  };
  const handleKeydown = async (event: KeyboardEvent) => {
    const modal = event.currentTarget;
    const layers = document.openClawModalLayers;
    if (
      event.defaultPrevented ||
      event.repeat ||
      !props.isOpen ||
      !(modal instanceof HTMLElement) ||
      layers?.size !== 1 ||
      !layers.has(modal)
    ) {
      return;
    }
    const host = props.newSessionHost;
    const context = host?.context;
    const newSession =
      matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession, event) &&
      host &&
      !host.onboardingMode &&
      readSessionMethodAccess(context?.gateway.snapshot, {
        method: "sessions.create",
        params: {},
        sessionScope: true,
      }).allowed;
    if (!newSession && !matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    props.host.isOpen = false;
    // Release modal ownership and restore focus before navigation focuses the composer.
    await props.host.updateComplete;
    if (
      props.host.isConnected &&
      !props.host.isOpen &&
      newSession &&
      host.isConnected &&
      host.context === context
    ) {
      openShellNewSession(host, "shortcut");
    }
  };
  return (
    <Show when={props.isOpen}>
      <openclaw-modal-dialog
        label={t("shortcutsOverlay.title")}
        onModal-cancel={close}
        onKeyDown={(event) => void handleKeydown(event)}
      >
        <div class="dialog">
          <header class="header">
            <h2>{t("shortcutsOverlay.title")}</h2>
            <button class="close" type="button" aria-label={t("common.close")} onClick={close}>
              <span aria-hidden="true">
                <Icon name="x" />
              </span>
            </button>
          </header>
          <div class="body">
            <For each={resolveKeyboardShortcutSections(props.sendShortcut)}>
              {(section) => (
                <section>
                  <h3>{t(section.label)}</h3>
                  <For each={section.entries}>
                    {(entry) => (
                      <div class="shortcut-row">
                        <span>{t(entry.label)}</span>
                        <span class="combos">
                          <For each={entry.combos}>
                            {(combo) => (
                              <span class="combo">
                                <KeyboardShortcut combo={combo} separateKeys />
                              </span>
                            )}
                          </For>
                        </span>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}

export const KeyboardShortcutsDialog = defineSolidBridge<DialogProps, DialogMethods>(
  "openclaw-keyboard-shortcuts-dialog",
  (props, host) => <KeyboardShortcutsContent {...props} host={host} />,
  {
    properties: {
      sendShortcut: { default: "enter", attribute: false },
      newSessionHost: { default: undefined, attribute: false },
      isOpen: { default: false, attribute: false },
    },
    methods: {
      toggle: (host) => {
        host.isOpen = !host.isOpen;
      },
    },
  },
);

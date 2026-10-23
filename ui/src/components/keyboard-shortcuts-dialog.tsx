import { For, Show } from "solid-js";
import { openShellNewSession, type ShellNewSessionHost } from "../app/app-shell-new-session.ts";
import type { ChatSendShortcut } from "../app/settings.ts";
import { resolveKeyboardShortcutSections } from "../lib/keyboard-shortcut-catalog.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
  resolveNewSessionShortcut,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import { KeyboardShortcut } from "./solid/kbd.tsx";
import "./kbd.css";
import "./keyboard-shortcuts-dialog.css";
import "./modal-dialog.tsx";

type DialogProps = {
  sendShortcut: ChatSendShortcut;
  newSessionHost?: ShellNewSessionHost;
  isOpen: boolean;
};
type DialogMethods = { toggle(): void };
export const KeyboardShortcutsDialog = defineSolidBridge<DialogProps, DialogMethods>(
  "openclaw-keyboard-shortcuts-dialog",
  (props, host) => {
    const close = (event: Event) => {
      // Removal owns focus restoration; do not also queue the modal's close callback.
      event.preventDefault();
      host.isOpen = false;
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
      const newSessionHost = props.newSessionHost;
      const context = newSessionHost?.context;
      const newSession =
        matchesShortcutCombo(resolveNewSessionShortcut(), event) &&
        newSessionHost &&
        !newSessionHost.onboardingMode &&
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
      host.isOpen = false;
      // Release modal ownership and restore focus before navigation focuses the composer.
      await host.updateComplete;
      if (
        host.isConnected &&
        !host.isOpen &&
        newSession &&
        newSessionHost.isConnected &&
        newSessionHost.context === context
      ) {
        openShellNewSession(newSessionHost, "shortcut");
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
  },
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

import { For, Show } from "solid-js";
import { openShellNewSession, type ShellNewSessionHost } from "../app/app-shell-new-session.ts";
import type { ChatSendShortcut } from "../app/settings.ts";
import { registerCommandPaletteEnglish } from "../i18n/locales/en-command-palette.ts";
import { isMobileBrowserPlatform } from "../lib/browser-platform.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
  resolveNewSessionShortcut,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import { KeyboardShortcut } from "./solid/kbd.tsx";
import "./keyboard-shortcuts-dialog.css";
import "./modal-dialog.tsx";

registerCommandPaletteEnglish();

type KeyboardShortcutEntry = ReturnType<typeof keyboardShortcutEntry>;
type KeyboardShortcutSection = ReturnType<typeof keyboardShortcutSection>;

function keyboardShortcutEntry(id: string, ...combos: readonly KeyboardShortcutCombo[]) {
  return { id, label: `shortcutsOverlay.labels.${id}`, combos } as const;
}

function keyboardShortcutSection(id: string, entries: readonly KeyboardShortcutEntry[]) {
  return { id, label: `shortcutsOverlay.sections.${id}`, entries } as const;
}

const KEYBOARD_SHORTCUT_SECTIONS = [
  keyboardShortcutSection("general", [
    keyboardShortcutEntry("commandPalette", KEYBOARD_SHORTCUT_COMBOS.commandPalette),
    keyboardShortcutEntry("newSession", KEYBOARD_SHORTCUT_COMBOS.newSession),
    keyboardShortcutEntry("paletteStartSession", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry("keyboardShortcuts", KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts),
    keyboardShortcutEntry("toggleSidebar", KEYBOARD_SHORTCUT_COMBOS.toggleSidebar),
    keyboardShortcutEntry("debugOverlay", KEYBOARD_SHORTCUT_COMBOS.debugOverlay),
    keyboardShortcutEntry("appearanceSettings", KEYBOARD_SHORTCUT_COMBOS.appearanceSettings),
    keyboardShortcutEntry("startNewSession", KEYBOARD_SHORTCUT_COMBOS.sendMessage),
    keyboardShortcutEntry("closeDialog", KEYBOARD_SHORTCUT_COMBOS.escape),
  ]),
  keyboardShortcutSection("chat", [
    keyboardShortcutEntry("archiveSession", KEYBOARD_SHORTCUT_COMBOS.archiveSession),
    keyboardShortcutEntry("sendMessage", KEYBOARD_SHORTCUT_COMBOS.sendMessage),
    keyboardShortcutEntry("newline", KEYBOARD_SHORTCUT_COMBOS.newline),
    keyboardShortcutEntry("steerImmediately", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry(
      "historyRecall",
      KEYBOARD_SHORTCUT_COMBOS.historyPrevious,
      KEYBOARD_SHORTCUT_COMBOS.historyNext,
    ),
    keyboardShortcutEntry("transcriptSearch", KEYBOARD_SHORTCUT_COMBOS.transcriptSearch),
    keyboardShortcutEntry("clearReply", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("stopResponse", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("cancelDictation", KEYBOARD_SHORTCUT_COMBOS.escape),
    keyboardShortcutEntry("saveQueuedMessage", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
  ]),
  keyboardShortcutSection("panels", [
    keyboardShortcutEntry("terminalPanel", KEYBOARD_SHORTCUT_COMBOS.terminalPanel),
    keyboardShortcutEntry("homePanel", KEYBOARD_SHORTCUT_COMBOS.homePanel),
    keyboardShortcutEntry("workspaceFiles", KEYBOARD_SHORTCUT_COMBOS.workspaceFiles),
    keyboardShortcutEntry("sideChat", KEYBOARD_SHORTCUT_COMBOS.sideChat),
    keyboardShortcutEntry("browserPanel", KEYBOARD_SHORTCUT_COMBOS.browserPanel),
    keyboardShortcutEntry("desktopPanel", KEYBOARD_SHORTCUT_COMBOS.desktopPanel),
    keyboardShortcutEntry("discussionPanel", KEYBOARD_SHORTCUT_COMBOS.discussionPanel),
    keyboardShortcutEntry("dashboardPanel", KEYBOARD_SHORTCUT_COMBOS.dashboardPanel),
    keyboardShortcutEntry("reviewPanel", KEYBOARD_SHORTCUT_COMBOS.reviewPanel),
  ]),
  keyboardShortcutSection("sidebar", [
    keyboardShortcutEntry("toggleSessionSelect", KEYBOARD_SHORTCUT_COMBOS.toggleSessionSelect),
    keyboardShortcutEntry("extendSessionSelect", KEYBOARD_SHORTCUT_COMBOS.extendSessionSelect),
  ]),
  keyboardShortcutSection("imageViewer", [
    keyboardShortcutEntry("zoomIn", KEYBOARD_SHORTCUT_COMBOS.zoomIn),
    keyboardShortcutEntry("zoomOut", KEYBOARD_SHORTCUT_COMBOS.zoomOut),
    keyboardShortcutEntry("zoomReset", KEYBOARD_SHORTCUT_COMBOS.zoomReset),
    keyboardShortcutEntry(
      "panImageHorizontal",
      KEYBOARD_SHORTCUT_COMBOS.imagePanLeft,
      KEYBOARD_SHORTCUT_COMBOS.imagePanRight,
    ),
    keyboardShortcutEntry(
      "panImageVertical",
      KEYBOARD_SHORTCUT_COMBOS.imagePanUp,
      KEYBOARD_SHORTCUT_COMBOS.imagePanDown,
    ),
  ]),
  keyboardShortcutSection("approvals", [
    keyboardShortcutEntry("approveOnce", KEYBOARD_SHORTCUT_COMBOS.modifiedEnter),
    keyboardShortcutEntry("approveAlways", KEYBOARD_SHORTCUT_COMBOS.approveAlways),
    keyboardShortcutEntry("denyApproval", KEYBOARD_SHORTCUT_COMBOS.denyApproval),
  ]),
] as const satisfies readonly KeyboardShortcutSection[];

// Both the chat composer and the new-session page submit on the same
// chatSendShortcut preference, so their displayed chords swap together.
const SEND_PREFERENCE_ENTRY_IDS = new Set(["sendMessage", "startNewSession"]);

function resolveKeyboardShortcutSections(
  sendShortcut: "enter" | "modifier-enter" = "enter",
): readonly KeyboardShortcutSection[] {
  const mobile = isMobileBrowserPlatform();
  return KEYBOARD_SHORTCUT_SECTIONS.map((section) =>
    keyboardShortcutSection(
      section.id,
      section.entries
        .filter(
          (entry) =>
            !mobile ||
            !(
              SEND_PREFERENCE_ENTRY_IDS.has(entry.id) ||
              entry.id === "paletteStartSession" ||
              entry.id === "steerImmediately" ||
              entry.id === "saveQueuedMessage"
            ),
        )
        .map((entry) =>
          mobile && entry.id === "newline"
            ? keyboardShortcutEntry(entry.id, KEYBOARD_SHORTCUT_COMBOS.sendMessage)
            : entry.id === "newSession"
              ? keyboardShortcutEntry(entry.id, resolveNewSessionShortcut())
              : !mobile &&
                  sendShortcut === "modifier-enter" &&
                  SEND_PREFERENCE_ENTRY_IDS.has(entry.id)
                ? keyboardShortcutEntry(entry.id, KEYBOARD_SHORTCUT_COMBOS.modifiedEnter)
                : entry,
        ),
    ),
  );
}

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

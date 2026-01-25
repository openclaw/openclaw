/**
 * Keyboard Shortcuts Help Modal
 * Shows all available keyboard shortcuts grouped by category
 */

import { html, render, nothing, type TemplateResult } from "lit";
import { icon } from "../icons";

type ShortcutCategory = {
  name: string;
  icon: string;
  shortcuts: Array<{
    keys: string[];
    description: string;
    when?: string;
  }>;
};

const SHORTCUTS: ShortcutCategory[] = [
  {
    name: "Global",
    icon: "command",
    shortcuts: [
      { keys: ["⌘", "K"], description: "Open command palette" },
      { keys: ["?"], description: "Show keyboard shortcuts" },
      { keys: ["Esc"], description: "Close modal / Clear input" },
    ],
  },
  {
    name: "Navigation",
    icon: "compass",
    shortcuts: [
      { keys: ["⌘", "1"], description: "Go to Chat" },
      { keys: ["⌘", "2"], description: "Go to Overview" },
      { keys: ["⌘", "3"], description: "Go to Channels" },
      { keys: ["⌘", "4"], description: "Go to Sessions" },
      { keys: ["⌘", ","], description: "Go to Config" },
    ],
  },
  {
    name: "Chat",
    icon: "messageSquare",
    shortcuts: [
      { keys: ["⌘", "Enter"], description: "Send message", when: "Chat view" },
      { keys: ["/"], description: "Focus input", when: "Chat view" },
    ],
  },
  {
    name: "Logs",
    icon: "scrollText",
    shortcuts: [
      { keys: ["⌘", "F"], description: "Focus search", when: "Logs view" },
      { keys: ["G"], description: "Jump to bottom", when: "Logs view" },
      { keys: ["F"], description: "Toggle auto-follow", when: "Logs view" },
      { keys: ["R"], description: "Refresh logs", when: "Logs view" },
    ],
  },
  {
    name: "Config",
    icon: "settings",
    shortcuts: [
      { keys: ["⌘", "S"], description: "Save config", when: "Config view" },
      { keys: ["/"], description: "Focus search", when: "Config view" },
    ],
  },
];

let isOpen = false;

function renderModal(): TemplateResult | typeof nothing {
  if (!isOpen) return nothing;

  const handleClose = () => {
    isOpen = false;
    renderToContainer();
    document.removeEventListener("keydown", handleKeydown);
  };

  const handleBackdropClick = (e: Event) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  };

  // Add keydown listener
  document.addEventListener("keydown", handleKeydown);

  return html`
    <div
      class="modal-backdrop keyboard-shortcuts-modal-backdrop"
      @click=${handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="keyboard-shortcuts-title"
    >
      <div class="modal keyboard-shortcuts-modal">
        <div class="modal-header">
          <h2 id="keyboard-shortcuts-title" class="modal-title">
            ${icon("keyboard", { size: 20 })}
            Keyboard Shortcuts
          </h2>
          <button
            class="btn btn--sm btn--icon"
            @click=${handleClose}
            aria-label="Close"
            title="Close"
          >
            ${icon("x", { size: 16 })}
          </button>
        </div>
        <div class="modal-body keyboard-shortcuts-body">
          <div class="keyboard-shortcuts-grid">
            ${SHORTCUTS.map(
              (category) => html`
                <div class="keyboard-shortcuts-category">
                  <h3 class="keyboard-shortcuts-category__title">
                    ${icon(category.icon as Parameters<typeof icon>[0], { size: 14 })}
                    ${category.name}
                  </h3>
                  <div class="keyboard-shortcuts-list">
                    ${category.shortcuts.map(
                      (shortcut) => html`
                        <div class="keyboard-shortcut">
                          <div class="keyboard-shortcut__keys">
                            ${shortcut.keys.map(
                              (key) => html`<kbd class="keyboard-shortcut__key">${key}</kbd>`
                            )}
                          </div>
                          <div class="keyboard-shortcut__desc">
                            ${shortcut.description}
                            ${shortcut.when
                              ? html`<span class="keyboard-shortcut__when">${shortcut.when}</span>`
                              : nothing}
                          </div>
                        </div>
                      `
                    )}
                  </div>
                </div>
              `
            )}
          </div>
        </div>
        <div class="modal-footer keyboard-shortcuts-footer">
          <span class="keyboard-shortcuts-tip">
            Press <kbd>?</kbd> anytime to show this help
          </span>
          <button class="btn btn--secondary" @click=${handleClose}>Close</button>
        </div>
      </div>
    </div>
  `;
}

function getOrCreateContainer(): HTMLElement {
  let container = document.getElementById("keyboard-shortcuts-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "keyboard-shortcuts-container";
    document.body.appendChild(container);
  }
  return container;
}

function renderToContainer() {
  const container = getOrCreateContainer();
  render(renderModal(), container);
}

/**
 * Show the keyboard shortcuts help modal
 */
export function showKeyboardShortcutsModal(): void {
  if (isOpen) return;
  isOpen = true;
  renderToContainer();
}

/**
 * Hide the keyboard shortcuts help modal
 */
export function hideKeyboardShortcutsModal(): void {
  if (!isOpen) return;
  isOpen = false;
  renderToContainer();
}

/**
 * Toggle the keyboard shortcuts help modal
 */
export function toggleKeyboardShortcutsModal(): void {
  if (isOpen) {
    hideKeyboardShortcutsModal();
  } else {
    showKeyboardShortcutsModal();
  }
}

/**
 * Check if the modal is currently open
 */
export function isKeyboardShortcutsModalOpen(): boolean {
  return isOpen;
}

/**
 * Mode switcher for the chat input toolbar.
 *
 * Renders a pill/chip showing the current execution mode with a dropdown
 * menu for switching between modes.
 *
 * Permission modes (Ask/Accept/Bypass) map to the existing session fields
 * `execSecurity` + `execAsk`, so no protocol schema change is required for
 * those.
 *
 * Plan mode is its own dimension — it sets `planMode: "plan"` via
 * `sessions.patch` (added in PR-8) and activates the runtime mutation gate
 * from #67538b. NOT mapped to execSecurity (that would block read-only exec
 * which plan mode explicitly needs for research). Permission mode and plan
 * mode coexist: a session can be in plan-mode-with-allowlist, etc.
 */

import { html, nothing, type TemplateResult } from "lit";

export interface ModeDefinition {
  id: string;
  label: string;
  shortLabel: string;
  shortcut: string;
  /**
   * Permission mode mapping (Ask/Accept/Bypass only).
   * Plan mode does NOT set these — see `planMode` field instead.
   */
  execSecurity?: string;
  execAsk?: string;
  /**
   * Plan mode toggle. When set to "plan", selecting this mode calls
   * sessions.patch with `planMode: "plan"`, activating the runtime
   * mutation gate from #67538b. PR-8 wires the RPC dispatch.
   */
  planMode?: "plan" | "normal";
  icon: TemplateResult;
}

const shieldIcon = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
</svg>`;
const checkIcon = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
  <path d="M22 4 12 14.01l-3-3" />
</svg>`;
const unlockIcon = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
  <path d="M7 11V7a5 5 0 0 1 9.9-1" />
</svg>`;
const planIcon = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M9 11l3 3L22 4" />
  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
</svg>`;

export const MODE_DEFINITIONS: ModeDefinition[] = [
  {
    id: "ask",
    label: "Ask permissions",
    shortLabel: "Ask",
    shortcut: "1",
    execSecurity: "allowlist",
    execAsk: "on-miss",
    icon: shieldIcon,
  },
  {
    id: "accept",
    label: "Accept edits",
    shortLabel: "Accept",
    shortcut: "2",
    execSecurity: "allowlist",
    execAsk: "off",
    icon: checkIcon,
  },
  // Plan mode: own dimension (not a permission permutation). Selecting Plan
  // calls sessions.patch with planMode:"plan" — wired in PR-8. The runtime
  // mutation gate from #67538b activates server-side. This entry has no
  // execSecurity/execAsk because plan mode coexists with whatever permission
  // mode is current. The mode switcher will show Plan as the active label
  // while plan mode is on; switching to any non-plan mode patches back to
  // planMode:"normal".
  {
    id: "plan",
    label: "Plan mode",
    shortLabel: "Plan",
    shortcut: "3",
    planMode: "plan",
    icon: planIcon,
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    shortLabel: "Bypass",
    shortcut: "4",
    execSecurity: "full",
    execAsk: "off",
    icon: unlockIcon,
  },
];

/**
 * Derives the current mode from session state.
 *
 * Plan mode wins when active — the chip displays "Plan" regardless of the
 * underlying permission mode, because plan mode is the most specific signal
 * about agent behavior.
 */
export function resolveCurrentMode(
  execSecurity?: string,
  execAsk?: string,
  planMode?: "plan" | "normal",
): ModeDefinition {
  if (planMode === "plan") {
    const planEntry = MODE_DEFINITIONS.find((m) => m.id === "plan");
    if (planEntry) {
      return planEntry;
    }
  }
  const match = MODE_DEFINITIONS.find(
    (m) => !m.planMode && m.execSecurity === execSecurity && m.execAsk === execAsk,
  );
  return match ?? MODE_DEFINITIONS[0];
}

export interface ModeSwitcherState {
  menuOpen: boolean;
}

/**
 * Renders the mode switcher chip + dropdown menu.
 */
export function renderModeSwitcher(params: {
  currentMode: ModeDefinition;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onSelectMode: (mode: ModeDefinition) => void;
}): TemplateResult {
  const { currentMode, menuOpen, onToggleMenu, onSelectMode } = params;

  return html`
    <div class="agent-chat__mode-switcher" aria-label="Execution mode selector">
      <button
        type="button"
        class="agent-chat__mode-chip"
        @click=${onToggleMenu}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape" && menuOpen) {
            e.preventDefault();
            onToggleMenu();
          }
        }}
        title="Switch mode (Ctrl+1-4)"
        aria-haspopup="menu"
        aria-expanded="${menuOpen ? "true" : "false"}"
      >
        ${currentMode.icon}
        <span class="agent-chat__mode-chip-label">${currentMode.shortLabel}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      ${menuOpen
        ? html`
            <div class="agent-chat__mode-menu" role="menu">
              ${MODE_DEFINITIONS.map(
                (mode) => html`
                  <button
                    type="button"
                    class="agent-chat__mode-menu__item ${mode.id === currentMode.id
                      ? "agent-chat__mode-menu__item--active"
                      : ""}"
                    role="menuitem"
                    @click=${() => {
                      onSelectMode(mode);
                    }}
                  >
                    ${mode.icon}
                    <span class="agent-chat__mode-menu__label">${mode.label}</span>
                    <kbd class="agent-chat__mode-menu__shortcut">Ctrl+${mode.shortcut}</kbd>
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

/**
 * Handles keyboard shortcuts for mode switching (Ctrl+1 through Ctrl+4).
 * Returns the selected mode if a shortcut matched, or null.
 *
 * Focus guard: when the user is typing in an input/textarea/contenteditable
 * surface, Ctrl+digit should not steal the keystroke. This prevents the
 * shortcut from interfering with users typing in the chat composer or
 * any other text field.
 */
export function handleModeShortcut(e: KeyboardEvent): ModeDefinition | null {
  // Only bare Ctrl+digit — exclude Cmd (macOS tab switch), Shift, and Alt modifiers.
  if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
    return null;
  }
  // Focus guard: skip when user is typing.
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active) {
      const tag = active.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (active as HTMLElement).isContentEditable) {
        return null;
      }
    }
  }
  const mode = MODE_DEFINITIONS.find((m) => m.shortcut === e.key);
  if (mode) {
    e.preventDefault();
    return mode;
  }
  return null;
}

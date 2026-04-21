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
  /**
   * PR-10 auto mode. When `planMode === "plan"` and this is true,
   * selecting the mode also patches `planApproval.action: "auto"` with
   * `autoEnabled: true`, arming the session's auto-approve flag so
   * future plan submissions resolve as "approve" without user
   * confirmation. Selecting plain "Plan" (planMode set, autoApprove
   * unset) clears the flag so the user can drop back to manual
   * approval mid-session.
   */
  planAutoApprove?: boolean;
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
// PR-10 plan-auto icon: lightning bolt over the plan checkmark to
// distinguish "auto-approving plan" from plain "plan mode."
const planAutoIcon = html`<svg
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
  <path d="M13 2L3 14h7l-1 8 11-12h-7l1-8z" />
</svg>`;

export const MODE_DEFINITIONS: ModeDefinition[] = [
  // "Default" clears the per-session execSecurity/execAsk overrides so
  // the runtime falls back to whatever's in agents.defaults / per-agent
  // config (the "normal agentic" mode the operator configured). This
  // is the truer post-plan-mode fallback than locking back to Ask —
  // most operator configs don't want every-mutation prompts.
  // Implementation note: handlers detect undefined execSecurity/execAsk
  // on this entry and DELETE the session-side overrides via patch.
  {
    id: "default",
    label: "Default permissions",
    shortLabel: "Default",
    shortcut: "1",
    icon: shieldIcon,
  },
  {
    id: "ask",
    label: "Ask each mutation",
    shortLabel: "Ask",
    shortcut: "2",
    execSecurity: "allowlist",
    execAsk: "on-miss",
    icon: shieldIcon,
  },
  {
    id: "accept",
    label: "Accept edits",
    shortLabel: "Accept",
    shortcut: "3",
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
    shortcut: "4",
    planMode: "plan",
    icon: planIcon,
  },
  // PR-10 plan-auto: same plan mode (mutation gate active, exit_plan_mode
  // still required) but the runtime auto-resolves submitted plans as
  // "approve" without user confirmation. Useful for long-running unattended
  // sessions where the user trusts the agent to plan + execute its own
  // checkpoints. Selecting plain "Plan" clears the flag.
  {
    id: "plan-auto",
    label: "Plan (auto-approve)",
    shortLabel: "Plan ⚡",
    shortcut: "5",
    planMode: "plan",
    planAutoApprove: true,
    icon: planAutoIcon,
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    shortLabel: "Bypass",
    shortcut: "6",
    execSecurity: "full",
    execAsk: "off",
    icon: unlockIcon,
  },
];

/**
 * Synthetic "Custom" mode displayed when the current
 * `(execSecurity, execAsk)` pair doesn't match any preset.
 *
 * Carries the actual values via `execSecurity`/`execAsk` so a future
 * tooltip/devtools surface can show the live state, and so picking a
 * preset from the menu makes the user's intent explicit (instead of
 * silently coercing the unrecognized state to a preset).
 */
const CUSTOM_MODE_ICON = html`<svg
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
  <circle cx="12" cy="12" r="3" />
  <path
    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  />
</svg>`;

/**
 * Derives the current mode from session state.
 *
 * Plan mode wins when active — the chip displays "Plan" regardless of
 * the underlying permission mode, because plan mode is the most specific
 * signal about agent behavior.
 *
 * If `(execSecurity, execAsk)` matches no preset (e.g. `security=deny`
 * for sandbox-backed sessions, or `ask=always` set elsewhere), a
 * synthetic "Custom" `ModeDefinition` is returned that carries the
 * actual values — instead of silently mislabeling the chip as "Ask".
 *
 * Bug-fix history (PR #67721): the prior fallback to
 * `MODE_DEFINITIONS[0]` (Ask) made the UI report Ask for valid
 * non-preset states and could quietly rewrite those states when the
 * user picked from the menu.
 */
export function resolveCurrentMode(
  execSecurity?: string,
  execAsk?: string,
  planMode?: "plan" | "executing" | "normal",
  planAutoApprove?: boolean,
): ModeDefinition {
  // PR #68939 follow-up (P2.6) — `"executing"` state renders the SAME
  // chip as `"plan"` (or "Plan ⚡" if autoApprove is set). The user's
  // mental model is "I'm in plan mode" through both designing the plan
  // AND watching the agent execute it; the chip should not silently
  // revert to "Default" the moment the approval lands.
  //
  // Pre-P2.6, mode flipped to "normal" on approve which made the chip
  // immediately revert — confusing because autoApprove was still
  // armed for the next cycle and the agent was actively executing.
  // Now mode stays "executing" until close-on-complete deletes
  // planMode entirely; the chip stays on Plan / Plan ⚡ throughout.
  if (planMode === "plan" || planMode === "executing") {
    // PR-10: prefer the "plan-auto" entry when the session's
    // autoApprove flag is set so the chip surfaces the auto state.
    // Falls back to plain "plan" when the flag is absent so existing
    // sessions render unchanged.
    if (planAutoApprove === true) {
      const autoEntry = MODE_DEFINITIONS.find((m) => m.id === "plan-auto");
      if (autoEntry) {
        return autoEntry;
      }
    }
    const planEntry = MODE_DEFINITIONS.find((m) => m.id === "plan");
    if (planEntry) {
      return planEntry;
    }
  }
  const match = MODE_DEFINITIONS.find(
    (m) => !m.planMode && m.execSecurity === execSecurity && m.execAsk === execAsk,
  );
  if (match) {
    return match;
  }
  // No preset match — fabricate a "Custom" entry instead of forcing Ask.
  // Synthesizing a fresh object means selecting another mode from the
  // menu is a real state change (currentMode.id !== chosen.id) and can
  // be intentionally confirmed by the caller.
  return {
    id: "custom",
    label: "Custom permissions",
    shortLabel: "Custom",
    shortcut: "",
    icon: CUSTOM_MODE_ICON,
    ...(execSecurity !== undefined ? { execSecurity } : {}),
    ...(execAsk !== undefined ? { execAsk } : {}),
  };
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
        title="Switch mode (Ctrl+1-6)"
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
            <div class="agent-chat__mode-menu">
              <!--
                ARIA accessibility note (PR #67721): previously declared
                role="menu" / role="menuitem" but did NOT implement the
                WAI-ARIA menu keyboard contract (arrow nav, Home/End,
                roving tabindex, focus trap). Per WAI-ARIA, claiming the
                menu role without those keyboard semantics misleads
                assistive tech. Rather than ship a partial menu, we
                expose this surface as a popover of plain <button>s —
                native button focus + Escape-on-chip already gives
                keyboard users a usable interaction with no false ARIA
                promise.
              -->
              ${MODE_DEFINITIONS.map(
                (mode) => html`
                  <button
                    type="button"
                    class="agent-chat__mode-menu__item ${mode.id === currentMode.id
                      ? "agent-chat__mode-menu__item--active"
                      : ""}"
                    @click=${() => {
                      onSelectMode(mode);
                    }}
                  >
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
/**
 * Walks the active-element chain across Shadow DOM roots to find the
 * deepest focused element. `document.activeElement` only returns the
 * first host along the path; for Lit / Web Component composer surfaces
 * with internal `<input>` / `<textarea>` / `[contenteditable]`, the
 * naive read returns the host (e.g. `<openclaw-chat-composer>`) and
 * misses the real focus target — so the focus guard would NOT bail and
 * Ctrl+1..N (where N covers every MODE_DEFINITIONS entry) would steal
 * keystrokes the user meant for the input.
 *
 * Returns `null` when no element is focused.
 */
function getDeepActiveElement(): Element | null {
  if (typeof document === "undefined") {
    return null;
  }
  let active: Element | null = document.activeElement;
  // Cap the traversal to avoid runaway loops on pathological component trees.
  for (let depth = 0; depth < 32 && active; depth += 1) {
    const root = (active as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (!root || !root.activeElement) {
      return active;
    }
    if (root.activeElement === active) {
      // Stable fixed point — done.
      return active;
    }
    active = root.activeElement;
  }
  return active;
}

export function handleModeShortcut(e: KeyboardEvent): ModeDefinition | null {
  // Only bare Ctrl+digit — exclude Cmd (macOS tab switch), Shift, and Alt modifiers.
  if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
    return null;
  }
  // Focus guard: skip when user is typing. Use a Shadow-DOM-aware traversal
  // so focus inside a Web Component's internal input also bails the shortcut.
  const active = getDeepActiveElement();
  if (active) {
    const tag = active.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || (active as HTMLElement).isContentEditable) {
      return null;
    }
  }
  const mode = MODE_DEFINITIONS.find((m) => m.shortcut === e.key);
  if (mode) {
    e.preventDefault();
    return mode;
  }
  return null;
}

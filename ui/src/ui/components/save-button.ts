/**
 * Save Button State Machine
 * Provides a button that shows different states: idle, saving, saved, error
 */

import { html, type TemplateResult } from "lit";
import { icon } from "../icons";

export type SaveButtonState = "idle" | "saving" | "saved" | "error";

export type SaveButtonOptions = {
  /** Current state of the button */
  state: SaveButtonState;
  /** Text to show in idle state (default: "Save") */
  idleText?: string;
  /** Text to show in saving state (default: "Saving...") */
  savingText?: string;
  /** Text to show in saved state (default: "Saved!") */
  savedText?: string;
  /** Text to show in error state (default: "Failed") */
  errorText?: string;
  /** Button variant (default: "primary") */
  variant?: "primary" | "secondary";
  /** Button size */
  size?: "sm" | "md";
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Additional CSS classes */
  className?: string;
};

/**
 * Render a save button with state machine
 */
export function saveButton(options: SaveButtonOptions): TemplateResult {
  const {
    state,
    idleText = "Save",
    savingText = "Saving...",
    savedText = "Saved!",
    errorText = "Failed",
    variant = "primary",
    size,
    disabled = false,
    onClick,
    className = "",
  } = options;

  const isDisabled = disabled || state === "saving";

  const stateClass = state !== "idle" ? `btn--${state}` : "";
  const variantClass = `btn--${variant}`;
  const sizeClass = size ? `btn--${size}` : "";

  const classes = [
    "btn",
    "btn--save",
    variantClass,
    sizeClass,
    stateClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (() => {
    switch (state) {
      case "saving":
        return html`
          <span class="btn__spinner"></span>
          <span>${savingText}</span>
        `;
      case "saved":
        return html`
          <span class="btn__icon">${icon("check", { size: 14 })}</span>
          <span>${savedText}</span>
        `;
      case "error":
        return html`
          <span class="btn__icon">${icon("x", { size: 14 })}</span>
          <span>${errorText}</span>
        `;
      case "idle":
      default:
        return html`<span>${idleText}</span>`;
    }
  })();

  return html`
    <button
      type="button"
      class="${classes}"
      ?disabled=${isDisabled}
      @click=${onClick}
      aria-busy=${state === "saving"}
    >
      ${content}
    </button>
  `;
}

/**
 * Create a save button state controller
 * Manages state transitions and auto-reset
 */
export function createSaveButtonController(options: {
  /** Callback when state changes */
  onStateChange: (state: SaveButtonState) => void;
  /** Duration to show "saved" state before returning to idle (default: 2000ms) */
  savedDuration?: number;
  /** Duration to show "error" state before returning to idle (default: 3000ms) */
  errorDuration?: number;
}) {
  const { onStateChange, savedDuration = 2000, errorDuration = 3000 } = options;

  let currentState: SaveButtonState = "idle";
  let resetTimer: number | null = null;

  function setState(state: SaveButtonState) {
    // Clear any pending reset
    if (resetTimer !== null) {
      window.clearTimeout(resetTimer);
      resetTimer = null;
    }

    currentState = state;
    onStateChange(state);

    // Auto-reset after saved/error states
    if (state === "saved") {
      resetTimer = window.setTimeout(() => {
        setState("idle");
      }, savedDuration);
    } else if (state === "error") {
      resetTimer = window.setTimeout(() => {
        setState("idle");
      }, errorDuration);
    }
  }

  return {
    /** Get the current state */
    getState: () => currentState,

    /** Set state to saving */
    startSaving: () => setState("saving"),

    /** Set state to saved (will auto-reset to idle) */
    setSaved: () => setState("saved"),

    /** Set state to error (will auto-reset to idle) */
    setError: () => setState("error"),

    /** Reset to idle state */
    reset: () => setState("idle"),

    /** Clean up (clear timers) */
    destroy: () => {
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
        resetTimer = null;
      }
    },

    /**
     * Wrap an async save function with state management
     */
    wrapSave: async <T>(saveFn: () => Promise<T>): Promise<T | undefined> => {
      setState("saving");
      try {
        const result = await saveFn();
        setState("saved");
        return result;
      } catch {
        setState("error");
        return undefined;
      }
    },
  };
}

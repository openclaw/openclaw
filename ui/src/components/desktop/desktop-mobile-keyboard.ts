import { onSettled } from "solid-js";
import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";

/**
 * Mobile browsers only report composed text through an input's value, so the desktop document
 * keeps a padded sentinel in the field and derives key events from how that value changed.
 */
const MOBILE_KEYBOARD_SENTINEL = "________________";

/** Bridges the document-owned textarea to the current remote keyboard. */
export function createDesktopMobileKeyboard(
  connectionTarget: () => DesktopConnectionHandle | null,
) {
  let value = MOBILE_KEYBOARD_SENTINEL;
  let field: HTMLTextAreaElement | undefined;
  let modifierConnection: DesktopConnectionHandle | null = null;
  const modifiers = new Map<string, KeyboardEvent>();
  onSettled(() => {
    const stopBlur = listen(window, "blur", () => modifiers.clear());
    const stopKeyup = listen(window, "keyup", handleWindowKeyup, true);
    return () => {
      stopBlur();
      stopKeyup();
      reset();
    };
  });

  function handleWindowKeyup(event: Event): void {
    // noVNC stops canvas keyups from bubbling. Capture physical releases after focus moves,
    // but ignore our synthetic forwarding and temporary paste releases.
    if (
      !(event instanceof KeyboardEvent) ||
      !event.isTrusted ||
      event.composedPath()[0] === field ||
      !modifiers.has(event.code)
    ) {
      return;
    }
    const connection = currentConnection();
    if (!connection || !modifiers.delete(event.code)) {
      return;
    }
    connection.sendKeyboardEvent(event);
  }

  function focus(event?: MouseEvent): void {
    const connection = currentConnection();
    if (event && connection) {
      reconcileModifiers(event, connection);
    }
    field?.focus({ preventScroll: true });
    field?.setSelectionRange(field.value.length, field.value.length);
  }

  function reset(input?: HTMLTextAreaElement): void {
    if (!input) {
      modifiers.clear();
      // A retired viewer must be releasable even if no keyboard input follows the handoff.
      modifierConnection = null;
    }
    value = MOBILE_KEYBOARD_SENTINEL;
    const target = input ?? field;
    if (target) {
      target.value = MOBILE_KEYBOARD_SENTINEL;
    }
  }

  function handleKeyboardEvent(event: KeyboardEvent): void {
    const connection = currentConnection();
    if (!connection) {
      return;
    }
    if (event.type === "keydown") {
      reconcileModifiers(event, connection);
    }
    // The textarea owns local paste; forwarding its shortcut suppresses browser input.
    if (
      !event.isComposing &&
      !event.altKey &&
      (isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
      event.key.toLowerCase() === "v"
    ) {
      return;
    }
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) {
      if (event.type === "keydown") {
        modifiers.set(event.code, event);
      } else {
        modifiers.delete(event.code);
      }
    }
    connection.sendKeyboardEvent(event);
    event.preventDefault();
  }

  function handleInput(event: InputEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    const connection = currentConnection();
    if (!connection) {
      reset(input);
      return;
    }
    const nextValue = input.value;
    // Paste is literal text even while the user still physically holds its shortcut modifiers.
    const pastedModifiers = event.inputType === "insertFromPaste" ? [...modifiers.values()] : [];
    for (const modifier of pastedModifiers) {
      connection.sendKeyboardEvent(new KeyboardEvent("keyup", modifier));
    }
    let prefixLength = 0;
    for (const character of value) {
      if (!nextValue.startsWith(character, prefixLength)) {
        break;
      }
      prefixLength += character.length;
    }
    // DOM offsets use UTF-16; a removed supplementary character is one key action.
    for (
      let remaining = Array.from(value.slice(prefixLength)).length;
      remaining > 0;
      remaining -= 1
    ) {
      connection.sendBackspace();
    }
    connection.sendText(nextValue.slice(prefixLength));
    for (const modifier of pastedModifiers) {
      connection.sendKeyboardEvent(modifier);
    }
    // Refill once the field drifts outside the range that keeps further deletes reportable.
    if (nextValue.length < 1 || nextValue.length > MOBILE_KEYBOARD_SENTINEL.length * 2) {
      reset(input);
      return;
    }
    value = nextValue;
  }

  function reconcileModifiers(
    event: MouseEvent | KeyboardEvent,
    connection: DesktopConnectionHandle,
  ): void {
    // Native popups can consume keyups. Only physical snapshots may retire those
    // modifiers; synthetic forwarding and paste events do not describe held keys.
    if (!event.isTrusted) {
      return;
    }
    for (const [code, modifier] of modifiers) {
      if (!event.getModifierState(modifier.key)) {
        modifiers.delete(code);
        connection.sendKeyboardEvent(new KeyboardEvent("keyup", modifier));
      }
    }
  }

  function currentConnection(): DesktopConnectionHandle | null {
    const connection = connectionTarget();
    if (connection !== modifierConnection) {
      modifiers.clear();
      modifierConnection = connection;
    }
    return connection;
  }
  return {
    inputRef: (element: HTMLTextAreaElement) => {
      field = element;
      field.value = value;
    },
    focus,
    reset,
    handleKeyboardEvent,
    handleInput,
  };
}

export type DesktopMobileKeyboard = ReturnType<typeof createDesktopMobileKeyboard>;

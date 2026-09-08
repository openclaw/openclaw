import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";
import type { DesktopConnectionHandle } from "./desktop-client.ts";

/**
 * Mobile browsers only report composed text through an input's value, so the desktop document
 * keeps a padded sentinel in the field and derives key events from how that value changed.
 */
const MOBILE_KEYBOARD_SENTINEL = "________________";

type MobileKeyboardOptions = {
  connection: () => DesktopConnectionHandle | null;
  controlling: () => boolean;
  input: () => HTMLTextAreaElement | null | undefined;
};

/** Bridges the desktop document's hidden textarea to the remote desktop's keyboard. */
export class DesktopMobileKeyboard {
  /** The document view renders this so the field always holds deletable padding. */
  value = MOBILE_KEYBOARD_SENTINEL;
  private modifierConnection: DesktopConnectionHandle | null = null;
  private readonly modifiers = new Map<string, KeyboardEvent>();
  private readonly clearModifiers = () => {
    this.modifiers.clear();
    window.removeEventListener("blur", this.clearModifiers);
    window.removeEventListener("keyup", this.handleWindowKeyup, true);
  };
  private readonly handleWindowKeyup = (event: KeyboardEvent) => {
    // noVNC stops canvas keyups from bubbling. Capture physical releases after focus moves,
    // but ignore our synthetic forwarding and temporary paste releases.
    if (!event.isTrusted || event.composedPath()[0] === this.options.input()) {
      return;
    }
    const connection = this.currentConnection();
    if (!connection || !this.modifiers.delete(event.code)) {
      return;
    }
    if (this.modifiers.size === 0) {
      this.clearModifiers();
    }
    connection.sendKeyboardEvent(event);
  };

  constructor(private readonly options: MobileKeyboardOptions) {}

  focus(): void {
    const input = this.options.input();
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  reset(input?: HTMLTextAreaElement): void {
    if (!input) {
      this.clearModifiers();
    }
    this.value = MOBILE_KEYBOARD_SENTINEL;
    const target = input ?? this.options.input();
    if (target) {
      target.value = MOBILE_KEYBOARD_SENTINEL;
    }
  }

  handleKeyboardEvent(event: KeyboardEvent): void {
    const connection = this.currentConnection();
    if (!connection) {
      return;
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
        this.modifiers.set(event.code, event);
        // noVNC releases held keys on window blur; do not restore stale modifiers afterward.
        window.addEventListener("blur", this.clearModifiers, { once: true });
        window.addEventListener("keyup", this.handleWindowKeyup, true);
      } else {
        this.modifiers.delete(event.code);
        if (this.modifiers.size === 0) {
          this.clearModifiers();
        }
      }
    }
    connection.sendKeyboardEvent(event);
    event.preventDefault();
  }

  handleInput(event: InputEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    const connection = this.currentConnection();
    if (!connection) {
      this.reset(input);
      return;
    }
    const nextValue = input.value;
    // Paste is literal text even while the user still physically holds its shortcut modifiers.
    const modifiers = event.inputType === "insertFromPaste" ? [...this.modifiers.values()] : [];
    for (const modifier of modifiers) {
      connection.sendKeyboardEvent(new KeyboardEvent("keyup", modifier));
    }
    let prefixLength = 0;
    for (const character of this.value) {
      if (!nextValue.startsWith(character, prefixLength)) {
        break;
      }
      prefixLength += character.length;
    }
    // DOM offsets use UTF-16; a removed supplementary character is one key action.
    for (
      let remaining = Array.from(this.value.slice(prefixLength)).length;
      remaining > 0;
      remaining -= 1
    ) {
      connection.sendBackspace();
    }
    connection.sendText(nextValue.slice(prefixLength));
    for (const modifier of modifiers) {
      connection.sendKeyboardEvent(modifier);
    }
    // Refill once the field drifts outside the range that keeps further deletes reportable.
    if (nextValue.length < 1 || nextValue.length > MOBILE_KEYBOARD_SENTINEL.length * 2) {
      this.reset(input);
      return;
    }
    this.value = nextValue;
  }

  private currentConnection(): DesktopConnectionHandle | null {
    const connection = this.options.controlling() ? this.options.connection() : null;
    if (connection !== this.modifierConnection) {
      this.clearModifiers();
      this.modifierConnection = connection;
    }
    return connection;
  }
}

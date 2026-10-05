import { normalizeChatSendShortcutOverride, type ChatSendShortcut } from "./settings.ts";

// Any mouse or trackpad, including one paired with a tablet, keeps Enter to send.
const TOUCH_ONLY_QUERY = "(pointer: coarse) and (any-hover: none)";

// jsdom lacks matchMedia and reports a pointer device.
export function isTouchOnlyInput(): boolean {
  return globalThis.matchMedia?.(TOUCH_ONLY_QUERY).matches ?? false;
}

// On-screen keyboards have no Shift+Enter, so an unset shortcut makes Return
// insert a new line there; Send and Ctrl/Cmd+Enter still submit. An explicit
// choice from Settings or the synced pref applies on every device.
export function resolveChatSendShortcut(value: unknown): ChatSendShortcut {
  return (
    normalizeChatSendShortcutOverride(value) ?? (isTouchOnlyInput() ? "modifier-enter" : "enter")
  );
}
